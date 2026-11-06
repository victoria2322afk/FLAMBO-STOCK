import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, makeClock } from './helpers.js';
import { buildXlsx, readXlsx } from '../src/xlsx.js';

// Martes 3/11/2026 12:00 en Buenos Aires. El lunes de esa semana es el 2/11.
const TUESDAY = '2026-11-03T15:00:00Z';
const OCTET = { 'Content-Type': 'application/octet-stream' };
const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const HEADER = ['Código', 'Producto', 'Grupo', 'Stock inicial', ...DAYS.flatMap((d) => [`${d} entrada`, `${d} salida`, `${d} total`])];

/** Fila de planilla: days = { 0: [entrada, salida], ... } */
function sheetRow(code, { init = 0, days = {} } = {}) {
  const row = [code, `Producto ${code}`, 'Grupo', init];
  for (let d = 0; d < 6; d += 1) {
    const [e, s] = days[d] || [0, 0];
    row.push(e, s, 0);
  }
  return row;
}

const makeFile = (rows, header = HEADER) => buildXlsx([{ name: 'Stock', rows: [header, ...rows] }]);

async function setup() {
  const clock = makeClock(TUESDAY);
  const t = await startTestServer({ clock, env: { TOKEN_TTL_SECONDS: String(90 * 24 * 3600) } });
  const admin = await t.adminToken();
  const central = (await t.request('GET', '/api/branches', { token: admin })).body.branches[0];
  const north = (await t.request('POST', '/api/branches', { token: admin, body: { name: 'Sucursal Norte' } })).body;
  const ana = await t.createEmployee(admin, { username: 'ana', branchId: central.id });
  const beto = await t.createEmployee(admin, { username: 'beto', branchId: north.id });
  const pid = (code) => t.db.get('SELECT id FROM products WHERE code = ?', code).id;
  const weekOf = async (branchId, token = admin) =>
    (await t.request('GET', `/api/branches/${branchId}/weeks/current`, { token })).body;
  const flat = (view) => view.groups.flatMap((g) => g.products);
  const find = (view, code) => flat(view).find((p) => p.code === code);
  const importFile = (weekId, buffer, token) =>
    t.request('POST', `/api/weeks/${weekId}/import`, { token, rawBody: buffer, headers: OCTET });
  return { t, clock, admin, central, north, ana, beto, pid, weekOf, find, flat, importFile };
}

async function fillCentral({ t, admin, ana, central, pid, weekOf }) {
  const week = (await weekOf(central.id)).week;
  await t.request('PUT', `/api/weeks/${week.id}/initial-stock`, { token: admin, body: { items: [{ productId: pid(206), qty: 5 }] } });
  await t.request('PUT', `/api/weeks/${week.id}/movements`, {
    token: ana.token,
    body: {
      changes: [
        { productId: pid(206), dayIndex: 0, entrada: 10, salida: 4 },
        { productId: pid(206), dayIndex: 1, salida: 1.5 },
        { productId: pid(226), dayIndex: 2, entrada: 3, salida: 2 },
      ],
    },
  });
  return week;
}

test('exportar: el archivo es un .xlsx válido con el contenido de la semana', async () => {
  const ctx = await setup();
  const { t, ana, beto, central } = ctx;
  try {
    const week = await fillCentral(ctx);
    const res = await t.request('GET', `/api/weeks/${week.id}/export.xlsx`, { token: ana.token });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="flambo-stock_Casa-Central_2026-11-02.xlsx"');
    assert.equal(res.body.subarray(0, 2).toString(), 'PK', 'empieza como un ZIP');

    const rows = readXlsx(res.body);
    assert.deepEqual(rows[0].slice(0, 7), ['Código', 'Producto', 'Grupo', 'Stock inicial', 'Lun entrada', 'Lun salida', 'Lun total']);
    assert.equal(rows[0].length, 4 + 18);
    assert.equal(rows.length, 1 + 51, 'un encabezado y 51 productos');

    const banana = rows.find((r) => r[0] === 206);
    assert.deepEqual(banana.slice(0, 4), [206, 'Banana', 'Bizcochos sueltos', 5]);
    assert.deepEqual(banana.slice(4, 7), [10, 4, 11], 'lunes: entrada, salida, total');
    assert.deepEqual(banana.slice(7, 10), [0, 1.5, 9.5], 'martes arranca del total del lunes');
    assert.equal(banana[4 + 3 * 5 + 2], 9.5, 'el total del sábado se arrastra');

    const vienes = rows.find((r) => r[0] === 226);
    assert.deepEqual(vienes.slice(10, 13), [3, 2, 1]);

    // Un empleado no puede exportar la semana de otra sucursal.
    assert.equal((await t.request('GET', `/api/weeks/${week.id}/export.xlsx`, { token: beto.token })).status, 403);
    assert.equal((await t.request('GET', `/api/weeks/${week.id}/export.xlsx`)).status, 401);
    assert.equal(central.name, 'Casa Central');
  } finally {
    await t.close();
  }
});

test('exportar y reimportar reproduce los mismos valores (criterio 7)', async () => {
  const ctx = await setup();
  const { t, admin, central, north, weekOf, flat, importFile } = ctx;
  try {
    const week = await fillCentral(ctx);
    const exported = (await t.request('GET', `/api/weeks/${week.id}/export.xlsx`, { token: admin })).body;

    // Reimportar en la misma semana no cambia nada.
    const same = await importFile(week.id, exported, admin);
    assert.equal(same.status, 200);
    assert.equal(same.body.cellsChanged, 0);
    assert.equal(same.body.products, 51);

    // Importar en otra sucursal reproduce stock inicial, entradas, salidas y totales.
    const northWeek = (await weekOf(north.id)).week;
    const imported = await importFile(northWeek.id, exported, admin);
    assert.equal(imported.status, 200);
    assert.equal(imported.body.cellsChanged, 3, 'tres celdas con datos: banana lunes y martes, vienés celeste miércoles');
    assert.equal(imported.body.initialUpdated, 51);
    assert.deepEqual(imported.body.warnings, []);

    const src = await t.request('GET', `/api/weeks/${week.id}`, { token: admin });
    const dst = await t.request('GET', `/api/weeks/${northWeek.id}`, { token: admin });
    assert.deepEqual(flat(dst.body), flat(src.body).map((p) => ({ ...p, minQty: null })));
  } finally {
    await t.close();
  }
});

test('importar como empleado: se aplican entradas y salidas pero no el stock inicial', async () => {
  const ctx = await setup();
  const { t, beto, north, weekOf, find, importFile } = ctx;
  try {
    const week = await fillCentral(ctx);
    const exported = (await t.request('GET', `/api/weeks/${week.id}/export.xlsx`, { token: ctx.admin })).body;
    const northWeek = (await weekOf(north.id)).week;

    const res = await importFile(northWeek.id, exported, beto.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.initialUpdated, 0);
    assert.equal(res.body.initialIgnored, 1, 'solo la banana tenía inicial distinto de cero');
    assert.match(res.body.warnings[0].message, /solo un admin/);

    const banana = find((await weekOf(north.id)), 206);
    assert.equal(banana.initial, 0, 'el stock inicial no se tocó');
    assert.equal(banana.days[0].entrada, 10);
    assert.equal(banana.days[1].salida, 1.5);
    assert.equal(banana.days[0].total, 6, '0 + 10 − 4');

    // No puede importar en la semana de otra sucursal.
    assert.equal((await importFile(week.id, exported, beto.token)).status, 403);
  } finally {
    await t.close();
  }
});

test('importar: archivos y filas inválidas se rechazan sin aplicar nada', async () => {
  const ctx = await setup();
  const { t, ana, admin, central, weekOf, find, importFile } = ctx;
  try {
    const week = (await weekOf(central.id)).week;
    const movementsBefore = () => t.db.get('SELECT COUNT(*) AS n FROM movements').n;
    const before = movementsBefore();

    const empty = await t.request('POST', `/api/weeks/${week.id}/import`, { token: ana.token, rawBody: Buffer.alloc(0), headers: OCTET });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'empty_file');

    const notZip = await importFile(week.id, Buffer.from('esto no es una planilla, es solo texto largo para pasar el mínimo'), ana.token);
    assert.equal(notZip.status, 400);
    assert.equal(notZip.body.error.code, 'invalid_file');

    const wrongHeader = await importFile(week.id, makeFile([[206, 'Banana']], ['Nombre', 'Cantidad']), ana.token);
    assert.equal(wrongHeader.status, 400);
    assert.equal(wrongHeader.body.error.code, 'invalid_format');

    const noRows = await importFile(week.id, makeFile([]), ana.token);
    assert.equal(noRows.status, 400);
    assert.equal(noRows.body.error.code, 'no_rows');

    // Una fila buena y varias malas: no se aplica ni la buena.
    const bad = await importFile(
      week.id,
      makeFile([
        sheetRow(206, { days: { 0: [9, 0] } }),
        sheetRow(226, { days: { 0: [-1, 0] } }),
        sheetRow(227, { days: { 1: [0, 'abc'] } }),
        sheetRow(239, { days: { 2: [1.2345, 0] } }),
        sheetRow(255, { days: { 3: [100001, 0] } }),
        sheetRow(280),
        sheetRow(280),
        ['x1', 'Raro'],
      ]),
      ana.token,
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_rows');
    const messages = bad.body.error.details.map((d) => `${d.row}: ${d.message}`);
    assert.deepEqual(messages, [
      '3: Lun entrada no puede ser negativo',
      '4: Mar salida no es un número',
      '5: Mié entrada tiene más de 3 decimales',
      '6: Jue entrada supera el máximo de 100000',
      '8: el código 280 aparece repetido',
      '9: el código "x1" no es válido',
    ]);
    assert.equal(movementsBefore(), before, 'no se escribió nada');
    assert.equal(find(await weekOf(central.id), 206).days[0].entrada, 0);

    // Un código desconocido es solo una advertencia: el resto se importa.
    const partial = await importFile(week.id, makeFile([sheetRow(206, { days: { 0: [9, 2] } }), sheetRow(99999, { days: { 0: [1, 1] } })]), ana.token);
    assert.equal(partial.status, 200);
    assert.equal(partial.body.products, 1);
    assert.equal(partial.body.cellsChanged, 1);
    assert.deepEqual(partial.body.warnings, [{ row: 3, message: 'el código 99999 no existe en el catálogo y se omitió' }]);

    // Coma decimal como texto y celdas vacías valen 0; reimportar sin los valores los pone en 0.
    const asText = await importFile(week.id, makeFile([sheetRow(206, { days: { 0: ['2,5', ''] } })]), ana.token);
    assert.equal(asText.status, 200);
    const d0 = find(await weekOf(central.id), 206).days[0];
    assert.deepEqual([d0.entrada, d0.salida], [2.5, 0]);

    // Semana cerrada: solo lectura.
    ctx.clock.set('2026-11-10T15:00:00Z');
    const closed = await importFile(week.id, makeFile([sheetRow(206, { days: { 0: [1, 0] } })]), admin);
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error.code, 'week_closed');
  } finally {
    await t.close();
  }
});

test('importar una planilla guardada por otro programa (cadenas compartidas)', async () => {
  const ctx = await setup();
  const { t, ana, central, weekOf, find, importFile } = ctx;
  try {
    const week = (await weekOf(central.id)).week;
    // Se arma a mano un .xlsx al estilo Excel: textos en sharedStrings y celdas vacías salteadas.
    const { zipFiles } = await import('../src/xlsx.js');
    const file = zipFiles([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'xl/sharedStrings.xml', data: '<sst><si><t>Código</t></si><si><t>Producto</t></si><si><t>Grupo</t></si><si><t>Stock inicial</t></si><si><t>Lun entrada</t></si></sst>' },
      {
        name: 'xl/worksheets/sheet1.xml',
        data:
          '<worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>' +
          '<row r="2"><c r="A2"><v>206</v></c><c r="E2"><v>7</v></c><c r="F2" s="3"/></row>' +
          '</sheetData></worksheet>',
      },
    ]);
    const res = await importFile(week.id, file, ana.token);
    assert.equal(res.status, 200);
    assert.equal(find(await weekOf(central.id), 206).days[0].entrada, 7);
  } finally {
    await t.close();
  }
});

test('la importación y la exportación quedan en la auditoría', async () => {
  const ctx = await setup();
  const { t, admin, ana } = ctx;
  try {
    const week = await fillCentral(ctx);
    await t.request('GET', `/api/weeks/${week.id}/export.xlsx`, { token: ana.token });
    await ctx.importFile(week.id, makeFile([sheetRow(206, { days: { 0: [1, 1] } })]), ana.token);

    const audit = await t.request('GET', '/api/audit?action=week_import', { token: admin });
    assert.equal(audit.body.total, 1);
    assert.equal(audit.body.entries[0].username, 'ana');
    assert.equal(audit.body.entries[0].branchName, 'Casa Central');
    assert.equal(audit.body.entries[0].detail.products, 1);
    assert.equal(audit.body.entries[0].detail.initialApplied, false);
    assert.equal((await t.request('GET', '/api/audit?action=week_export', { token: admin })).body.total, 1);
  } finally {
    await t.close();
  }
});
