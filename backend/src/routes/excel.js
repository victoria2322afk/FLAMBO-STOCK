import { HttpError, Raw } from '../http.js';
import { idParam } from '../validate.js';
import { audit } from '../audit.js';
import { isAdmin, requireBranch } from '../permissions.js';
import { buildWeekView, ensureCurrentWeek, getWeek, round3 } from '../services/weeks.js';
import { buildXlsx, readXlsx } from '../xlsx.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_QTY = 100000;
const MAX_REPORTED = 50;

const SHORT_DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const FIXED_HEADERS = ['Código', 'Producto', 'Grupo', 'Stock inicial'];

// Columnas (base 0): A código, B producto, C grupo, D stock inicial, y luego 3 por día:
// entrada, salida y total. El total es solo informativo: al importar se vuelve a calcular.
const entradaCol = (d) => 4 + d * 3;
const salidaCol = (d) => 5 + d * 3;

const safeName = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sucursal';

/** Convierte una celda en número ≥ min, o devuelve un mensaje de error. */
function readQty(value, { min }) {
  if (value === undefined || value === null || value === '') return { value: 0 };
  let n = value;
  if (typeof n === 'string') {
    const text = n.trim().replace(',', '.');
    if (text === '') return { value: 0 };
    n = Number(text);
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'no es un número' };
  const rounded = Math.round(n * 1000) / 1000;
  if (Math.abs(rounded - n) > 1e-9) return { error: 'tiene más de 3 decimales' };
  if (rounded < min) return { error: min === 0 ? 'no puede ser negativo' : `debe ser mayor o igual a ${min}` };
  if (rounded > MAX_QTY) return { error: `supera el máximo de ${MAX_QTY}` };
  return { value: rounded };
}

export function exportRows(view) {
  const header = [...FIXED_HEADERS];
  view.week.days.forEach((day, d) => {
    header.push(`${SHORT_DAYS[d]} entrada`, `${SHORT_DAYS[d]} salida`, `${SHORT_DAYS[d]} total`);
    void day;
  });
  const rows = [header];
  for (const g of view.groups) {
    for (const p of g.products) {
      const row = [p.code, p.name, g.name, p.initial];
      p.days.forEach((d) => row.push(d.entrada, d.salida, d.total));
      rows.push(row);
    }
  }
  return rows;
}

export function registerExcelRoutes(router, { config, db, now }) {
  function loadWeekFor(user, weekId) {
    const found = getWeek(db, weekId);
    requireBranch(db, user, found.branch_id);
    ensureCurrentWeek(db, config, now, found.branch_id);
    return getWeek(db, weekId);
  }

  router.get('/api/weeks/:id/export.xlsx', (ctx) => {
    const week = loadWeekFor(ctx.user, idParam(ctx.params.id));
    const view = buildWeekView(db, config, now, week);
    const rows = exportRows(view);

    const info = [
      ['Dato', 'Valor'],
      ['Sucursal', view.week.branchName],
      ['Semana desde', view.week.startDate],
      ['Semana hasta', view.week.endDate],
      ['Estado', view.week.status === 'open' ? 'Abierta' : 'Cerrada'],
      ['Exportado', now().toISOString()],
    ];

    const body = buildXlsx([
      {
        name: 'Stock',
        rows,
        widths: [9, 26, 18, 13, ...view.week.days.flatMap(() => [11, 11, 11])],
        freeze: { cols: 2, rows: 1 },
      },
      { name: 'Info', rows: info, widths: [16, 34] },
    ]);

    const filename = `flambo-stock_${safeName(view.week.branchName)}_${view.week.startDate}.xlsx`;
    audit(db, now, {
      userId: ctx.user.id,
      branchId: week.branch_id,
      action: 'week_export',
      entity: 'week',
      entityId: week.id,
    });
    return new Raw(200, {
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': body.length,
    }, body);
  });

  // El cuerpo es el archivo .xlsx tal cual (application/octet-stream o el tipo de Excel).
  router.post('/api/weeks/:id/import', { raw: true }, (ctx) => {
    const week = loadWeekFor(ctx.user, idParam(ctx.params.id));
    if (week.status !== 'open') {
      throw new HttpError(409, 'week_closed', 'La semana ya está cerrada y no se puede modificar.');
    }
    if (!ctx.rawBody || ctx.rawBody.length === 0) {
      throw new HttpError(400, 'empty_file', 'No se recibió ningún archivo.');
    }

    let rows;
    try {
      rows = readXlsx(ctx.rawBody);
    } catch (err) {
      throw new HttpError(400, 'invalid_file', `No se pudo leer la planilla: ${err.message}`);
    }

    const header = rows[0] || [];
    const looksRight =
      String(header[0] ?? '').trim().toLowerCase() === 'código' || String(header[0] ?? '').trim().toLowerCase() === 'codigo';
    if (!looksRight || !String(header[3] ?? '').toLowerCase().startsWith('stock inicial')) {
      throw new HttpError(
        400,
        'invalid_format',
        'La planilla no tiene el formato esperado. Usá una planilla exportada desde Flambo Stock.',
      );
    }

    const productByCode = new Map(db.all('SELECT id, code, name FROM products').map((p) => [p.code, p]));
    const existing = new Map(
      db
        .all('SELECT product_id, day_index, entrada, salida FROM movements WHERE week_id = ?', week.id)
        .map((r) => [`${r.product_id}:${r.day_index}`, r]),
    );

    const errors = [];
    const warnings = [];
    const seen = new Set();
    const initial = []; // { productId, qty }
    const cells = []; // { productId, day, entrada, salida }
    const addError = (row, message) => {
      if (errors.length < MAX_REPORTED) errors.push({ row, message });
    };
    const addWarning = (row, message) => {
      if (warnings.length < MAX_REPORTED) warnings.push({ row, message });
    };

    for (let r = 1; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const line = r + 1;
      const rawCode = row[0];
      if (rawCode === undefined || rawCode === null || rawCode === '') continue;
      const code = typeof rawCode === 'number' ? rawCode : Number(String(rawCode).trim());
      if (!Number.isInteger(code)) {
        addError(line, `el código "${rawCode}" no es válido`);
        continue;
      }
      const product = productByCode.get(code);
      if (!product) {
        addWarning(line, `el código ${code} no existe en el catálogo y se omitió`);
        continue;
      }
      if (seen.has(code)) {
        addError(line, `el código ${code} aparece repetido`);
        continue;
      }
      seen.add(code);

      const init = readQty(row[3], { min: -MAX_QTY });
      if (init.error) addError(line, `Stock inicial ${init.error}`);
      else initial.push({ productId: product.id, qty: init.value });

      for (let d = 0; d < 6; d += 1) {
        const e = readQty(row[entradaCol(d)], { min: 0 });
        const s = readQty(row[salidaCol(d)], { min: 0 });
        if (e.error) addError(line, `${SHORT_DAYS[d]} entrada ${e.error}`);
        if (s.error) addError(line, `${SHORT_DAYS[d]} salida ${s.error}`);
        if (!e.error && !s.error) cells.push({ productId: product.id, day: d, entrada: e.value, salida: s.value });
      }
    }

    if (errors.length > 0) {
      throw new HttpError(400, 'invalid_rows', 'La planilla tiene valores inválidos. No se importó nada.', errors);
    }
    if (seen.size === 0) {
      throw new HttpError(400, 'no_rows', 'La planilla no tiene productos para importar.', warnings);
    }

    const admin = isAdmin(ctx.user);
    const stamp = now().toISOString();
    let applied = 0;

    db.tx(() => {
      for (const c of cells) {
        const prev = existing.get(`${c.productId}:${c.day}`);
        if (!prev && c.entrada === 0 && c.salida === 0) continue; // no crear filas en cero
        if (prev && prev.entrada === c.entrada && prev.salida === c.salida) continue; // sin cambios
        db.run(
          `INSERT INTO movements (week_id, product_id, day_index, entrada, salida, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (week_id, product_id, day_index) DO UPDATE SET
             entrada = excluded.entrada, salida = excluded.salida,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          week.id,
          c.productId,
          c.day,
          c.entrada,
          c.salida,
          stamp,
          ctx.user.id,
        );
        applied += 1;
      }
      if (admin) {
        for (const item of initial) {
          db.run(
            `INSERT INTO week_initial_stock (week_id, product_id, qty) VALUES (?, ?, ?)
             ON CONFLICT (week_id, product_id) DO UPDATE SET qty = excluded.qty`,
            week.id,
            item.productId,
            item.qty,
          );
        }
      }
      audit(db, now, {
        userId: ctx.user.id,
        branchId: week.branch_id,
        action: 'week_import',
        entity: 'week',
        entityId: week.id,
        detail: { products: seen.size, cellsChanged: applied, initialApplied: admin, warnings: warnings.length },
      });
    });

    let initialIgnored = 0;
    if (!admin) {
      const current = new Map(
        db.all('SELECT product_id, qty FROM week_initial_stock WHERE week_id = ?', week.id).map((r) => [r.product_id, r.qty]),
      );
      initialIgnored = initial.filter((i) => round3(current.get(i.productId) ?? 0) !== i.qty).length;
      if (initialIgnored > 0) {
        addWarning(0, `${initialIgnored} valor(es) de "Stock inicial" no se aplicaron: solo un admin puede cambiarlo.`);
      }
    }

    return {
      products: seen.size,
      cellsChanged: applied,
      initialUpdated: admin ? initial.length : 0,
      initialIgnored,
      warnings,
    };
  });
}
