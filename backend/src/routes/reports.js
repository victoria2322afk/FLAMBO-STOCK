import { HttpError } from '../http.js';
import { addDays } from '../dates.js';
import { isAdmin, requireBranch } from '../permissions.js';
import { buildWeekView, currentStartDate, ensureCurrentWeek, getWeek, round3 } from '../services/weeks.js';

function intQuery(value, { name, def, min, max }) {
  if (value === undefined || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, 'validation_error', `${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return n;
}

export function registerReportRoutes(router, { config, db, now }) {
  /**
   * Sucursal sobre la que se calcula un reporte.
   * Empleado: siempre la suya. Admin: la indicada, o todas si no indica ninguna.
   */
  function scopeBranch(ctx) {
    if (!isAdmin(ctx.user)) {
      if (ctx.query.branchId && Number(ctx.query.branchId) !== ctx.user.branchId) {
        requireBranch(db, ctx.user, Number(ctx.query.branchId)); // lanza 403 / 404
      }
      return ctx.user.branchId;
    }
    if (ctx.query.branchId === undefined || ctx.query.branchId === '') return null;
    const id = intQuery(ctx.query.branchId, { name: 'branchId', min: 1, max: 1_000_000_000 });
    requireBranch(db, ctx.user, id);
    return id;
  }

  function viewForWeek(user, weekId) {
    const found = getWeek(db, weekId);
    requireBranch(db, user, found.branch_id);
    ensureCurrentWeek(db, config, now, found.branch_id);
    return buildWeekView(db, config, now, getWeek(db, weekId));
  }

  const weekIdQuery = (value, name) => intQuery(value, { name, min: 1, max: 1_000_000_000 });

  /** Resumen de una semana: entradas, salidas y total final por producto y por grupo. */
  router.get('/api/reports/week-summary', (ctx) => {
    if (ctx.query.weekId === undefined) throw new HttpError(400, 'validation_error', 'Falta weekId.');
    const view = viewForWeek(ctx.user, weekIdQuery(ctx.query.weekId, 'weekId'));

    let totalEntradas = 0;
    let totalSalidas = 0;
    const groups = view.groups.map((g) => {
      let ge = 0;
      let gs = 0;
      const products = g.products.map((p) => {
        const entradas = round3(p.days.reduce((n, d) => n + d.entrada, 0));
        const salidas = round3(p.days.reduce((n, d) => n + d.salida, 0));
        ge += entradas;
        gs += salidas;
        return { id: p.id, code: p.code, name: p.name, initial: p.initial, entradas, salidas, final: p.days[5].total };
      });
      totalEntradas += ge;
      totalSalidas += gs;
      return { id: g.id, name: g.name, entradas: round3(ge), salidas: round3(gs), products };
    });

    return { week: view.week, totals: { entradas: round3(totalEntradas), salidas: round3(totalSalidas) }, groups };
  });

  /** Productos con más salidas en las últimas N semanas (incluida la actual). */
  router.get('/api/reports/top-products', (ctx) => {
    const branchId = scopeBranch(ctx);
    const weeks = intQuery(ctx.query.weeks, { name: 'weeks', def: 4, min: 1, max: 52 });
    const limit = intQuery(ctx.query.limit, { name: 'limit', def: 10, min: 1, max: 100 });
    const from = addDays(currentStartDate(config, now), -7 * (weeks - 1));

    const rows = db.all(
      `SELECT p.id, p.code, p.name, SUM(m.salida) AS salidas, SUM(m.entrada) AS entradas
         FROM movements m
         JOIN weeks w ON w.id = m.week_id
         JOIN products p ON p.id = m.product_id
        WHERE w.start_date >= ? AND (? IS NULL OR w.branch_id = ?)
        GROUP BY p.id
       HAVING SUM(m.salida) > 0
        ORDER BY salidas DESC, p.code
        LIMIT ?`,
      from,
      branchId,
      branchId,
      limit,
    );
    return {
      branchId,
      from,
      weeks,
      products: rows.map((r) => ({
        productId: r.id,
        code: r.code,
        name: r.name,
        salidas: round3(r.salidas),
        entradas: round3(r.entradas),
      })),
    };
  });

  /** Evolución de entradas y salidas semana a semana (y día a día), con huecos rellenados en cero. */
  router.get('/api/reports/trend', (ctx) => {
    const branchId = scopeBranch(ctx);
    const weeks = intQuery(ctx.query.weeks, { name: 'weeks', def: 8, min: 1, max: 52 });
    const current = currentStartDate(config, now);
    const from = addDays(current, -7 * (weeks - 1));

    const rows = db.all(
      `SELECT w.start_date, m.day_index, SUM(m.entrada) AS entradas, SUM(m.salida) AS salidas
         FROM movements m JOIN weeks w ON w.id = m.week_id
        WHERE w.start_date >= ? AND (? IS NULL OR w.branch_id = ?)
        GROUP BY w.start_date, m.day_index`,
      from,
      branchId,
      branchId,
    );

    const byWeek = new Map();
    for (let i = 0; i < weeks; i += 1) {
      const start = addDays(from, 7 * i);
      byWeek.set(start, { startDate: start, entradas: 0, salidas: 0, days: Array.from({ length: 6 }, () => ({ entradas: 0, salidas: 0 })) });
    }
    for (const r of rows) {
      const w = byWeek.get(r.start_date);
      if (!w) continue;
      w.days[r.day_index] = { entradas: round3(r.entradas), salidas: round3(r.salidas) };
      w.entradas = round3(w.entradas + r.entradas);
      w.salidas = round3(w.salidas + r.salidas);
    }
    return { branchId, weeks: [...byWeek.values()] };
  });

  /** Compara dos semanas producto por producto (por código), ordenado por mayor cambio en salidas. */
  router.get('/api/reports/compare-weeks', (ctx) => {
    if (ctx.query.a === undefined || ctx.query.b === undefined) {
      throw new HttpError(400, 'validation_error', 'Indicá las semanas a comparar con a y b.');
    }
    const a = viewForWeek(ctx.user, weekIdQuery(ctx.query.a, 'a'));
    const b = viewForWeek(ctx.user, weekIdQuery(ctx.query.b, 'b'));

    const collect = (view) => {
      const map = new Map();
      for (const g of view.groups) {
        for (const p of g.products) {
          map.set(p.code, {
            code: p.code,
            name: p.name,
            entradas: round3(p.days.reduce((n, d) => n + d.entrada, 0)),
            salidas: round3(p.days.reduce((n, d) => n + d.salida, 0)),
          });
        }
      }
      return map;
    };
    const ma = collect(a);
    const mb = collect(b);

    const products = [];
    for (const code of new Set([...ma.keys(), ...mb.keys()])) {
      const pa = ma.get(code) || { entradas: 0, salidas: 0 };
      const pb = mb.get(code) || { entradas: 0, salidas: 0 };
      if (pa.entradas === 0 && pa.salidas === 0 && pb.entradas === 0 && pb.salidas === 0) continue;
      products.push({
        code,
        name: (ma.get(code) || mb.get(code)).name,
        a: { entradas: pa.entradas, salidas: pa.salidas },
        b: { entradas: pb.entradas, salidas: pb.salidas },
        deltaSalidas: round3(pb.salidas - pa.salidas),
        deltaEntradas: round3(pb.entradas - pa.entradas),
      });
    }
    products.sort((x, y) => Math.abs(y.deltaSalidas) - Math.abs(x.deltaSalidas) || x.code - y.code);

    const sum = (list, side, key) => round3(list.reduce((n, p) => n + p[side][key], 0));
    const label = (v) => ({ id: v.week.id, branchName: v.week.branchName, startDate: v.week.startDate });
    return {
      a: { ...label(a), entradas: sum(products, 'a', 'entradas'), salidas: sum(products, 'a', 'salidas') },
      b: { ...label(b), entradas: sum(products, 'b', 'entradas'), salidas: sum(products, 'b', 'salidas') },
      products,
    };
  });
}
