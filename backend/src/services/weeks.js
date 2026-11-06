import { addDays, currentDayIndex, DAY_NAMES, diffDays, mondayOf, todayLocal } from '../dates.js';
import { audit } from '../audit.js';
import { notFound } from '../http.js';

export const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Calcula los 6 días de un producto: total = inicial + entrada - salida,
 * y el total de cada día es el inicial del siguiente.
 * @param {number} initial Stock inicial de la semana
 * @param {Array<{entrada:number, salida:number}|undefined>} byDay Movimientos por día (0..5)
 */
export function computeDays(initial, byDay) {
  let running = initial;
  const days = [];
  for (let d = 0; d < 6; d += 1) {
    const m = byDay[d] || { entrada: 0, salida: 0 };
    const total = round3(running + m.entrada - m.salida);
    days.push({ initial: round3(running), entrada: m.entrada, salida: m.salida, total });
    running = total;
  }
  return days;
}

/**
 * Lunes de la semana vigente. La semana termina el domingo a las 00:00 hora local,
 * por eso el domingo ya se considera la semana siguiente.
 */
export function currentStartDate(config, now) {
  const today = todayLocal(config.tzName, now());
  return mondayOf(addDays(today, 1));
}

/** Total final (sábado) de cada producto que tuvo stock inicial o movimientos en la semana. */
function finalTotals(db, weekId) {
  const totals = new Map(
    db.all('SELECT product_id, qty FROM week_initial_stock WHERE week_id = ?', weekId).map((r) => [r.product_id, r.qty]),
  );
  const sums = db.all(
    'SELECT product_id, SUM(entrada) AS e, SUM(salida) AS s FROM movements WHERE week_id = ? GROUP BY product_id',
    weekId,
  );
  for (const r of sums) totals.set(r.product_id, round3((totals.get(r.product_id) ?? 0) + r.e - r.s));
  return totals;
}

function openWeek(db, now, branchId, startDate, initialByProduct) {
  const info = db.run("INSERT INTO weeks (branch_id, start_date, status) VALUES (?, ?, 'open')", branchId, startDate);
  const id = Number(info.lastInsertRowid);
  for (const { id: productId } of db.all('SELECT id FROM products')) {
    db.run(
      'INSERT INTO week_initial_stock (week_id, product_id, qty) VALUES (?, ?, ?)',
      id,
      productId,
      initialByProduct.get(productId) ?? 0,
    );
  }
  audit(db, now, { branchId, action: 'week_open', entity: 'week', entityId: id, detail: { startDate } });
  return { id, branch_id: branchId, start_date: startDate, status: 'open', closed_at: null };
}

/**
 * Garantiza que la sucursal tenga su semana vigente abierta. Si el domingo ya pasó,
 * cierra la semana anterior y abre la siguiente con el stock final como inicial.
 * Si pasaron varias semanas sin uso, crea y cierra las intermedias (en cero).
 * Es seguro llamarla en cada pedido: si no hay nada que hacer, es una sola consulta.
 */
export function ensureCurrentWeek(db, config, now, branchId) {
  const target = currentStartDate(config, now);
  const latestSql = 'SELECT * FROM weeks WHERE branch_id = ? ORDER BY start_date DESC LIMIT 1';

  const quick = db.get(latestSql, branchId);
  if (quick && quick.start_date >= target) return quick;

  return db.tx(() => {
    let latest = db.get(latestSql, branchId);
    if (!latest) return openWeek(db, now, branchId, target, new Map());

    while (latest.start_date < target) {
      const totals = finalTotals(db, latest.id);
      if (latest.status === 'open') {
        db.run("UPDATE weeks SET status = 'closed', closed_at = ? WHERE id = ?", now().toISOString(), latest.id);
        audit(db, now, {
          branchId,
          action: 'week_close',
          entity: 'week',
          entityId: latest.id,
          detail: { startDate: latest.start_date, auto: true },
        });
      }
      latest = openWeek(db, now, branchId, addDays(latest.start_date, 7), totals);
    }
    return latest;
  });
}

/** Tarea programada: pone al día la semana de todas las sucursales activas. */
export function runMaintenance(db, config, now) {
  let processed = 0;
  for (const { id } of db.all('SELECT id FROM branches WHERE active = 1')) {
    try {
      ensureCurrentWeek(db, config, now, id);
      processed += 1;
    } catch (err) {
      console.error(`[mantenimiento] Error al actualizar la semana de la sucursal ${id}:`, err);
    }
  }
  return processed;
}

export function getWeek(db, weekId) {
  const week = db.get(
    `SELECT w.id, w.branch_id, w.start_date, w.status, w.closed_at, b.name AS branch_name
       FROM weeks w JOIN branches b ON b.id = w.branch_id WHERE w.id = ?`,
    weekId,
  );
  if (!week) throw notFound('La semana no existe.');
  return week;
}

/** Vista completa de una semana: grupos, productos y los 6 días calculados. */
export function buildWeekView(db, config, now, week) {
  const today = todayLocal(config.tzName, now());
  const isOpen = week.status === 'open';

  const initial = new Map(
    db.all('SELECT product_id, qty FROM week_initial_stock WHERE week_id = ?', week.id).map((r) => [r.product_id, r.qty]),
  );
  const moves = new Map();
  for (const r of db.all('SELECT product_id, day_index, entrada, salida FROM movements WHERE week_id = ?', week.id)) {
    if (!moves.has(r.product_id)) moves.set(r.product_id, []);
    moves.get(r.product_id)[r.day_index] = { entrada: r.entrada, salida: r.salida };
  }
  const mins = new Map(
    db.all('SELECT product_id, min_qty FROM min_stock WHERE branch_id = ?', week.branch_id).map((r) => [r.product_id, r.min_qty]),
  );

  const productsByGroup = new Map();
  for (const p of db.all('SELECT id, code, name, active, group_id FROM products ORDER BY id')) {
    const init = initial.get(p.id) ?? 0;
    const byDay = moves.get(p.id) || [];
    const hasData = init !== 0 || byDay.some(Boolean);
    if (!p.active && !hasData) continue; // un producto inactivo sin datos en la semana no se muestra
    if (!productsByGroup.has(p.group_id)) productsByGroup.set(p.group_id, []);
    productsByGroup.get(p.group_id).push({
      id: p.id,
      code: p.code,
      name: p.name,
      active: Boolean(p.active),
      initial: round3(init),
      minQty: mins.has(p.id) ? mins.get(p.id) : null,
      days: computeDays(init, byDay),
    });
  }

  const groups = db
    .all('SELECT id, name FROM product_groups ORDER BY sort_order, id')
    .map((g) => ({ id: g.id, name: g.name, products: productsByGroup.get(g.id) || [] }))
    .filter((g) => g.products.length > 0);

  return {
    week: {
      id: week.id,
      branchId: week.branch_id,
      branchName: week.branch_name,
      startDate: week.start_date,
      endDate: addDays(week.start_date, 5),
      status: week.status,
      closedAt: week.closed_at,
      currentDayIndex: isOpen ? currentDayIndex(week.start_date, today) : null,
      days: DAY_NAMES.map((name, index) => ({ index, name, date: addDays(week.start_date, index) })),
    },
    groups,
  };
}

/** Stock "de hoy": el total del día vigente; antes del lunes de la semana, el stock inicial. */
export function stockToday(product, startDate, today) {
  const diff = diffDays(startDate, today);
  if (diff < 0) return product.days[0].initial;
  return product.days[Math.min(diff, 5)].total;
}

/** Productos activos cuyo stock de hoy está por debajo del mínimo definido para la sucursal. */
export function buildAlerts(view, today) {
  const alerts = [];
  for (const g of view.groups) {
    for (const p of g.products) {
      if (!p.active || p.minQty === null || p.minQty <= 0) continue;
      const stock = stockToday(p, view.week.startDate, today);
      if (stock < p.minQty) {
        alerts.push({
          productId: p.id,
          code: p.code,
          name: p.name,
          groupName: g.name,
          minQty: p.minQty,
          stock,
          missing: round3(p.minQty - stock),
        });
      }
    }
  }
  return alerts.sort((a, b) => b.missing - a.missing);
}
