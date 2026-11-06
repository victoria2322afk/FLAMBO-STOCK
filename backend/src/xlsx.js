import zlib from 'node:zlib';

/**
 * Lector y escritor mínimo de archivos .xlsx, sin dependencias externas.
 * Soporta lo que usa Flambo Stock: varias hojas, texto, números y negrita en encabezados.
 */

const MAX_ENTRIES = 200;
const MAX_UNCOMPRESSED = 20 * 1024 * 1024;

// ---------------------------------------------------------------- ZIP

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** Arma un ZIP a partir de [{ name, data: Buffer|string }]. */
export function zipFiles(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // Fecha fija (1/1/2026) para que el resultado sea reproducible.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const packed = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate),
      u32(crc), u32(packed.length), u32(raw.length), u16(name.length), u16(0), name, packed,
    ]);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate),
        u32(crc), u32(packed.length), u32(raw.length), u16(name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Lee un ZIP y devuelve Map(nombre -> Buffer). Lanza Error si el archivo no es válido. */
export function unzipFiles(buffer) {
  if (buffer.length < 22) throw new Error('El archivo no es un ZIP válido.');
  let eocd = -1;
  const stop = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= stop; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('El archivo no es un ZIP válido.');

  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('El archivo tiene demasiados elementos.');

  const out = new Map();
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('El archivo ZIP está dañado.');
    }
    const method = buffer.readUInt16LE(pos + 10);
    const compSize = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('El archivo ZIP está dañado.');
    }
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > buffer.length) throw new Error('El archivo ZIP está dañado.');
    const slice = buffer.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(slice);
    else if (method === 8) data = zlib.inflateRawSync(slice, { maxOutputLength: MAX_UNCOMPRESSED });
    else throw new Error('El ZIP usa una compresión no soportada.');

    total += data.length;
    if (total > MAX_UNCOMPRESSED) throw new Error('El archivo descomprimido es demasiado grande.');
    out.set(name, data);
  }
  return out;
}

// ---------------------------------------------------------------- XML

const xmlEscape = (str) =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Caracteres de control no permitidos en XML 1.0
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const xmlUnescape = (str) =>
  str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function colName(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------------------------------------------------------- Escritura

/**
 * @param {Array<{name:string, rows:Array<Array<string|number|null>>, widths?:number[], headerRows?:number}>} sheets
 */
export function buildXlsx(sheets) {
  const sheetXml = (sheet) => {
    const rowsXml = sheet.rows
      .map((row, r) => {
        const style = r < (sheet.headerRows ?? 1) ? ' s="1"' : '';
        const cells = row
          .map((value, c) => {
            if (value === null || value === undefined || value === '') return '';
            const ref = `${colName(c)}${r + 1}`;
            if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
            return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join('');
    const cols = (sheet.widths || [])
      .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
      .join('');
    const frozen = sheet.freeze
      ? `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${sheet.freeze.cols}" ySplit="${sheet.freeze.rows}" topLeftCell="${colName(sheet.freeze.cols)}${sheet.freeze.rows + 1}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`
      : '';
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      frozen +
      (cols ? `<cols>${cols}</cols>` : '') +
      `<sheetData>${rowsXml}</sheetData></worksheet>`
    );
  };

  const files = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
          .join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${sheets.map((sh, i) => `<sheet name="${xmlEscape(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    },
    {
      name: 'xl/styles.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) })),
  ];
  return zipFiles(files);
}

// ---------------------------------------------------------------- Lectura

function parseSharedStrings(xml) {
  const list = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m = re.exec(xml);
  while (m) {
    const parts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlUnescape(x[1]));
    list.push(parts.join(''));
    m = re.exec(xml);
  }
  return list;
}

/**
 * Devuelve las filas de la primera hoja como arreglos de valores (string | number | null),
 * indexadas desde 0. Las filas vacías intermedias quedan como arreglos vacíos.
 */
export function readXlsx(buffer) {
  const files = unzipFiles(buffer);
  if (!files.has('xl/workbook.xml')) throw new Error('El archivo no es una planilla de Excel (.xlsx).');

  const shared = files.has('xl/sharedStrings.xml') ? parseSharedStrings(files.get('xl/sharedStrings.xml').toString('utf8')) : [];

  const names = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  names.sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (names.length === 0) throw new Error('La planilla no tiene hojas.');
  const xml = files.get(names[0]).toString('utf8');

  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm = rowRe.exec(xml);
  let autoRow = 0;
  while (rm) {
    const attrRow = /\br="(\d+)"/.exec(rm[1]);
    const rowIndex = attrRow ? Number(attrRow[1]) - 1 : autoRow;
    autoRow = rowIndex + 1;
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm = cellRe.exec(rm[2] || '');
    let autoCol = 0;
    while (cm) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      const col = ref ? colIndex(ref[1]) : autoCol;
      autoCol = col + 1;
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const body = cm[2] || '';
      let value = null;
      if (type === 'inlineStr') {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlUnescape(x[1])).join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        if (v) {
          if (type === 's') value = shared[Number(v[1])] ?? null;
          else if (type === 'str') value = xmlUnescape(v[1]);
          else if (type === 'b') value = v[1] === '1' ? 1 : 0;
          else if (type === 'e') value = null;
          else {
            const num = Number(v[1]);
            value = Number.isFinite(num) ? num : null;
          }
        }
      }
      if (value !== null && value !== '') cells[col] = value;
      cm = cellRe.exec(rm[2] || '');
    }
    rows[rowIndex] = cells;
    rm = rowRe.exec(xml);
  }
  for (let i = 0; i < rows.length; i += 1) rows[i] ||= [];
  return rows;
}
