import { s, parse, idParam } from '../validate.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { todayLocal } from '../dates.js';
import { requireBranch } from '../permissions.js';
import { buildAlerts, buildWeekView, ensureCurrentWeek, getWeek } from '../services/weeks.js';

const MAX_QTY = 100000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const movementsSchema = s.obj({
  changes: s.array(
    s.obj({
      productId: s.int({ min: 1 }),
      dayIndex: s.int({ min: 0, max: 5 }),
      entrada: s.num({ min: 0, max: MAX_QTY, optional: true }),
      salida: s.num({ min: 0, max: MAX_QTY, optional: true }),
      clientTs: s.str({ max: 40, optional: true }),
    }),
    { min: 1, max: 500 },
  ),
});

const initialSchema = s.obj({
  items: s.array(s.obj({ productId: s.int({ min: 1 }), qty: s.num({ min: -MAX_QTY, max: MAX_QTY }) }), { min: 1, max: 1000 }),
});

const minStockSchema = s.obj({
  items: s.array(
    s.obj({ productId: s.int({ min: 1 }), minQty: s.num({ min: 0, max: MAX_QTY, nullable: true }) }),
    { min: 1, max: 1000 },
  ),
});

export function registerWeekRoutes(router, { config, db, now }) {
  /** Carga la semana, valida permiso sobre su sucursal y la pone al día (cierre automático perezoso). */
  function loadWeekFor(user, weekId) {
    const found = getWeek(db, weekId);
    requireBranch(db, user, found.branch_id);
    ensureCurrentWeek(db, config, now, found.branch_id);
    return getWeek(db, weekId); // puede haberse cerrado recién
  }

  function assertOpen(week) {
    if (week.status !== 'open') {
      throw new HttpError(409, 'week_closed', 'La semana ya está cerrada y no se puede modificar.');
    }
  }

  router.get('/api/branches/:id/weeks/current', (ctx) => {
    const branch = requireBranch(db, ctx.user, idParam(ctx.params.id));
    const open = ensureCurrentWeek(db, config, now, branch.id);
    return buildWeekView(db, config, now, getWeek(db, open.id));
  });

  router.get('/api/branches/:id/weeks', (ctx) => {
    const branch = requireBranch(db, ctx.user, idParam(ctx.params.id));
    ensureCurrentWeek(db, config, now, branch.id);
    const limit = Math.min(Math.max(Number.parseInt(ctx.query.limit, 10) || 52, 1), 200);
    const offset = Math.max(Number.parseInt(ctx.query.offset, 10) || 0, 0);
    const total = db.get('SELECT COUNT(*) AS n FROM weeks WHERE branch_id = ?', branch.id).n;
    const rows = db.all(
      `SELECT w.id, w.start_date, w.status, w.closed_at,
              COALESCE((SELECT SUM(entrada) FROM movements m WHERE m.week_id = w.id), 0) AS entradas,
              COALESCE((SELECT SUM(salida) FROM movements m WHERE m.week_id = w.id), 0) AS salidas
         FROM weeks w WHERE w.branch_id = ?
        ORDER BY w.start_date DESC LIMIT ? OFFSET ?`,
      branch.id,
      limit,
      offset,
    );
    return {
      total,
      weeks: rows.map((r) => ({
        id: r.id,
        startDate: r.start_date,
        status: r.status,
        closedAt: r.closed_at,
        entradas: Math.round(r.entradas * 1000) / 1000,
        salidas: Math.round(r.salidas * 1000) / 1000,
      })),
    };
  });

  router.get('/api/weeks/:id', (ctx) => {
    const week = loadWeekFor(ctx.user, idParam(ctx.params.id));
    return buildWeekView(db, config, now, week);
  });

  // Lote idempotente: fija valores de celdas (producto + día). Gana el último en escribir por celda.
  router.put('/api/weeks/:id/movements', (ctx) => {
    const week = loadWeekFor(ctx.user, idParam(ctx.params.id));
    const input = parse(movementsSchema, ctx.body);
    assertOpen(week);

    for (const c of input.changes) {
      if (c.entrada === undefined && c.salida === undefined) {
        throw new HttpError(400, 'validation_error', 'Cada cambio debe indicar entrada, salida o ambas.');
      }
    }

    const nowMs = now().getTime();
    const skipped = [];
    const applied = [];

    db.tx(() => {
      for (const c of input.changes) {
        const ref = { productId: c.productId, dayIndex: c.dayIndex };
        if (!db.get('SELECT 1 AS x FROM products WHERE id = ?', c.productId)) {
          skipped.push({ ...ref, reason: 'unknown_product' });
          continue;
        }
        let ts = c.clientTs ? Date.parse(c.clientTs) : Number.NaN;
        if (Number.isNaN(ts)) ts = nowMs;
        ts = Math.min(ts, nowMs + FUTURE_SKEW_MS);

        const existing = db.get(
          'SELECT entrada, salida, updated_at FROM movements WHERE week_id = ? AND product_id = ? AND day_index = ?',
          week.id,
          c.productId,
          c.dayIndex,
        );
        if (existing && Date.parse(existing.updated_at) > ts) {
          skipped.push({ ...ref, reason: 'stale' });
          continue;
        }

        const entrada = c.entrada ?? existing?.entrada ?? 0;
        const salida = c.salida ?? existing?.salida ?? 0;
        db.run(
          `INSERT INTO movements (week_id, product_id, day_index, entrada, salida, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (week_id, product_id, day_index) DO UPDATE SET
             entrada = excluded.entrada, salida = excluded.salida,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          week.id,
          c.productId,
          c.dayIndex,
          entrada,
          salida,
          new Date(ts).toISOString(),
          ctx.user.id,
        );
        applied.push({ ...ref, entrada, salida });
      }
      audit(db, now, {
        userId: ctx.user.id,
        branchId: week.branch_id,
        action: 'movements_update',
        entity: 'week',
        entityId: week.id,
        detail: { applied: applied.length, skipped: skipped.length, changes: applied.slice(0, 100) },
      });
    });

    return { applied: applied.length, skipped, serverTime: now().toISOString() };
  });

  router.put('/api/weeks/:id/initial-stock', { roles: ['admin'] }, (ctx) => {
    const week = loadWeekFor(ctx.user, idParam(ctx.params.id));
    const input = parse(initialSchema, ctx.body);
    assertOpen(week);

    for (const item of input.items) {
      if (!db.get('SELECT 1 AS x FROM products WHERE id = ?', item.productId)) {
        throw new HttpError(400, 'validation_error', `El producto ${item.productId} no existe.`);
      }
    }
    db.tx(() => {
      for (const item of input.items) {
        db.run(
          `INSERT INTO week_initial_stock (week_id, product_id, qty) VALUES (?, ?, ?)
           ON CONFLICT (week_id, product_id) DO UPDATE SET qty = excluded.qty`,
          week.id,
          item.productId,
          item.qty,
        );
      }
      audit(db, now, {
        userId: ctx.user.id,
        branchId: week.branch_id,
        action: 'initial_stock_update',
        entity: 'week',
        entityId: week.id,
        detail: { items: input.items.slice(0, 100) },
      });
    });
    return { updated: input.items.length };
  });

  router.get('/api/branches/:id/alerts', (ctx) => {
    const branch = requireBranch(db, ctx.user, idParam(ctx.params.id));
    const open = ensureCurrentWeek(db, config, now, branch.id);
    const view = buildWeekView(db, config, now, getWeek(db, open.id));
    const today = todayLocal(config.tzName, now());
    return {
      weekId: view.week.id,
      dayIndex: view.week.currentDayIndex,
      alerts: buildAlerts(view, today),
    };
  });

  router.get('/api/branches/:id/min-stock', (ctx) => {
    const branch = requireBranch(db, ctx.user, idParam(ctx.params.id));
    const items = db.all(
      `SELECT p.id AS product_id, p.code, p.name, g.name AS group_name, m.min_qty
         FROM products p
         JOIN product_groups g ON g.id = p.group_id
         LEFT JOIN min_stock m ON m.product_id = p.id AND m.branch_id = ?
        WHERE p.active = 1
        ORDER BY g.sort_order, g.id, p.id`,
      branch.id,
    );
    return {
      items: items.map((r) => ({
        productId: r.product_id,
        code: r.code,
        name: r.name,
        groupName: r.group_name,
        minQty: r.min_qty ?? null,
      })),
    };
  });

  router.put('/api/branches/:id/min-stock', { roles: ['admin'] }, (ctx) => {
    const branch = requireBranch(db, ctx.user, idParam(ctx.params.id));
    const input = parse(minStockSchema, ctx.body);
    for (const item of input.items) {
      if (!db.get('SELECT 1 AS x FROM products WHERE id = ?', item.productId)) {
        throw new HttpError(400, 'validation_error', `El producto ${item.productId} no existe.`);
      }
    }
    db.tx(() => {
      for (const item of input.items) {
        if (item.minQty === null) {
          db.run('DELETE FROM min_stock WHERE branch_id = ? AND product_id = ?', branch.id, item.productId);
        } else {
          db.run(
            `INSERT INTO min_stock (branch_id, product_id, min_qty) VALUES (?, ?, ?)
             ON CONFLICT (branch_id, product_id) DO UPDATE SET min_qty = excluded.min_qty`,
            branch.id,
            item.productId,
            item.minQty,
          );
        }
      }
      audit(db, now, {
        userId: ctx.user.id,
        branchId: branch.id,
        action: 'min_stock_update',
        entity: 'branch',
        entityId: branch.id,
        detail: { items: input.items.slice(0, 100) },
      });
    });
    return { updated: input.items.length };
  });
}
