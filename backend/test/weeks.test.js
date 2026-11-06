import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, makeClock } from './helpers.js';
import { runMaintenance } from '../src/services/weeks.js';

// Martes 3/11/2026 12:00 en Buenos Aires (UTC-3). El lunes de esa semana es el 2/11.
const TUESDAY = '2026-11-03T15:00:00Z';

async function setup(iso = TUESDAY) {
  const clock = makeClock(iso);
  // Token de 90 días: varios tests adelantan el reloj semanas y no deben depender del vencimiento de sesión.
  const t = await startTestServer({ clock, env: { TOKEN_TTL_SECONDS: String(90 * 24 * 3600) } });
  const admin = await t.adminToken();
  const branches = (await t.request('GET', '/api/branches', { token: admin })).body.branches;
  const branchId = branches[0].id;
  const employee = await t.createEmployee(admin, { username: 'ana', branchId });
  const pid = (code) => t.db.get('SELECT id FROM products WHERE code = ?', code).id;
  const current = () => t.request('GET', `/api/branches/${branchId}/weeks/current`, { token: admin });
  const find = (view, code) => view.groups.flatMap((g) => g.products).find((p) => p.code === code);
  return { t, clock, admin, employee, branchId, pid, current, find };
}

test('la semana vigente se crea sola: lunes a sábado, stock inicial en cero', async () => {
  const { t, admin, current, find } = await setup();
  try {
    const res = await current();
    assert.equal(res.status, 200);
    const { week, groups } = res.body;
    assert.equal(week.startDate, '2026-11-02');
    assert.equal(week.endDate, '2026-11-07');
    assert.equal(week.status, 'open');
    assert.equal(week.currentDayIndex, 1, 'martes = día 1');
    assert.deepEqual(week.days.map((d) => d.name), ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']);
    assert.equal(week.days[0].date, '2026-11-02');
    assert.equal(week.days[5].date, '2026-11-07');
    assert.equal(groups.length, 6);

    const banana = find(res.body, 206);
    assert.equal(banana.initial, 0);
    assert.ok(banana.days.every((d) => d.total === 0));

    const noToken = await t.request('GET', `/api/weeks/${week.id}`);
    assert.equal(noToken.status, 401);
  } finally {
    await t.close();
  }
});

test('total = inicial + entradas − salidas y se arrastra al día siguiente (criterio 2)', async () => {
  const { t, admin, employee, pid, current, find } = await setup();
  try {
    const week = (await current()).body.week;
    const banana = pid(206);

    const init = await t.request('PUT', `/api/weeks/${week.id}/initial-stock`, {
      token: admin,
      body: { items: [{ productId: banana, qty: 5 }] },
    });
    assert.equal(init.status, 200);

    // El empleado carga el lunes (un día anterior al vigente): está permitido.
    const put = await t.request('PUT', `/api/weeks/${week.id}/movements`, {
      token: employee.token,
      body: { changes: [{ productId: banana, dayIndex: 0, entrada: 10, salida: 4 }] },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.applied, 1);

    let p = find((await current()).body, 206);
    assert.equal(p.days[0].initial, 5);
    assert.equal(p.days[0].total, 11);
    assert.equal(p.days[1].initial, 11, 'el total del lunes es el inicial del martes');
    assert.equal(p.days[5].total, 11);

    // Decimales y total negativo.
    await t.request('PUT', `/api/weeks/${week.id}/movements`, {
      token: employee.token,
      body: {
        changes: [
          { productId: banana, dayIndex: 1, salida: 1.5 },
          { productId: banana, dayIndex: 2, salida: 20 },
        ],
      },
    });
    p = find((await current()).body, 206);
    assert.equal(p.days[1].total, 9.5);
    assert.equal(p.days[2].total, -10.5, 'el total puede quedar negativo');
    assert.equal(p.days[5].total, -10.5);
  } finally {
    await t.close();
  }
});

test('un lote enviado dos veces deja el mismo resultado (criterio 6)', async () => {
  const { t, employee, pid, current } = await setup();
  try {
    const week = (await current()).body.week;
    const batch = {
      changes: [
        { productId: pid(206), dayIndex: 0, entrada: 3, clientTs: '2026-11-03T14:00:00Z' },
        { productId: pid(226), dayIndex: 1, entrada: 2, salida: 1, clientTs: '2026-11-03T14:00:01Z' },
      ],
    };
    const first = await t.request('PUT', `/api/weeks/${week.id}/movements`, { token: employee.token, body: batch });
    const afterFirst = (await current()).body;
    const second = await t.request('PUT', `/api/weeks/${week.id}/movements`, { token: employee.token, body: batch });
    const afterSecond = (await current()).body;
    assert.equal(first.body.applied, 2);
    assert.equal(second.body.applied, 2);
    assert.deepEqual(afterSecond, afterFirst);
  } finally {
    await t.close();
  }
});

test('por celda gana el último en escribir; los cambios viejos se descartan', async () => {
  const { t, clock, employee, pid, current, find } = await setup();
  try {
    const week = (await current()).body.week;
    const banana = pid(206);
    const send = (change) =>
      t.request('PUT', `/api/weeks/${week.id}/movements`, { token: employee.token, body: { changes: [change] } });

    const first = await send({ productId: banana, dayIndex: 0, entrada: 7, salida: 2, clientTs: '2026-11-03T15:00:00Z' });
    assert.equal(first.body.applied, 1);

    const stale = await send({ productId: banana, dayIndex: 0, entrada: 99, clientTs: '2026-11-03T14:00:00Z' });
    assert.equal(stale.body.applied, 0);
    assert.deepEqual(stale.body.skipped, [{ productId: banana, dayIndex: 0, reason: 'stale' }]);
    assert.equal(find((await current()).body, 206).days[0].entrada, 7);

    // Un cambio más nuevo que solo trae la entrada conserva la salida anterior.
    const newer = await send({ productId: banana, dayIndex: 0, entrada: 8, clientTs: '2026-11-03T15:02:00Z' });
    assert.equal(newer.body.applied, 1);
    const d0 = find((await current()).body, 206).days[0];
    assert.equal(d0.entrada, 8);
    assert.equal(d0.salida, 2);

    // Una fecha del cliente absurda (año 2099) se recorta a "ahora + 5 min": no bloquea la celda para siempre.
    const absurd = await send({ productId: banana, dayIndex: 3, entrada: 1, clientTs: '2099-01-01T00:00:00Z' });
    assert.equal(absurd.body.applied, 1);
    const row = t.db.get('SELECT updated_at FROM movements WHERE week_id = ? AND product_id = ? AND day_index = 3', week.id, banana);
    assert.equal(row.updated_at, '2026-11-03T15:05:00.000Z', 'se recorta a ahora + 5 minutos');

    clock.set('2026-11-03T15:10:00Z');
    const later = await send({ productId: banana, dayIndex: 3, entrada: 2, clientTs: '2026-11-03T15:10:00Z' });
    assert.equal(later.body.applied, 1, 'pasado el margen, un cambio legítimo posterior sí se aplica');
    assert.equal(find((await current()).body, 206).days[3].entrada, 2);
  } finally {
    await t.close();
  }
});

test('validaciones de movimientos', async () => {
  const { t, admin, employee, pid, current } = await setup();
  try {
    const week = (await current()).body.week;
    const send = (changes, token = employee.token) =>
      t.request('PUT', `/api/weeks/${week.id}/movements`, { token, body: { changes } });
    const banana = pid(206);

    assert.equal((await send([{ productId: banana, dayIndex: 0, entrada: -1 }])).status, 400);
    assert.equal((await send([{ productId: banana, dayIndex: 0, entrada: 1.2345 }])).status, 400);
    assert.equal((await send([{ productId: banana, dayIndex: 6, entrada: 1 }])).status, 400);
    assert.equal((await send([{ productId: banana, dayIndex: 0, entrada: 100001 }])).status, 400);
    assert.equal((await send([{ productId: banana, dayIndex: 0 }])).status, 400, 'sin entrada ni salida');
    assert.equal((await send([])).status, 400);

    const unknown = await send([{ productId: 999999, dayIndex: 0, entrada: 1 }, { productId: banana, dayIndex: 0, entrada: 1 }]);
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.applied, 1);
    assert.equal(unknown.body.skipped[0].reason, 'unknown_product');

    assert.equal((await send([{ productId: banana, dayIndex: 0, entrada: '2,5' }])).status, 200, 'acepta coma decimal como texto');

    const adminOnly = await t.request('PUT', `/api/weeks/${week.id}/initial-stock`, {
      token: employee.token,
      body: { items: [{ productId: banana, qty: 5 }] },
    });
    assert.equal(adminOnly.status, 403, 'el stock inicial solo lo edita el admin');
    assert.equal((await t.request('GET', '/api/weeks/abc', { token: admin })).status, 400);
    assert.equal((await t.request('GET', '/api/weeks/99999', { token: admin })).status, 404);
  } finally {
    await t.close();
  }
});

test('un empleado no ve ni modifica otra sucursal (criterio 1)', async () => {
  const { t, admin, employee, branchId, pid, current } = await setup();
  try {
    const week = (await current()).body.week;
    const other = await t.request('POST', '/api/branches', { token: admin, body: { name: 'Sucursal Norte' } });
    const otherEmp = await t.createEmployee(admin, { username: 'beto', branchId: other.body.id });

    const mine = await t.request('GET', `/api/branches/${other.body.id}/weeks/current`, { token: otherEmp.token });
    assert.equal(mine.status, 200);
    assert.notEqual(mine.body.week.id, week.id);

    assert.equal((await t.request('GET', `/api/branches/${branchId}/weeks/current`, { token: otherEmp.token })).status, 403);
    assert.equal((await t.request('GET', `/api/weeks/${week.id}`, { token: otherEmp.token })).status, 403);
    assert.equal((await t.request('GET', `/api/branches/${branchId}/weeks`, { token: otherEmp.token })).status, 403);
    assert.equal((await t.request('GET', `/api/branches/${branchId}/alerts`, { token: otherEmp.token })).status, 403);
    const write = await t.request('PUT', `/api/weeks/${week.id}/movements`, {
      token: otherEmp.token,
      body: { changes: [{ productId: pid(206), dayIndex: 0, entrada: 1 }] },
    });
    assert.equal(write.status, 403);

    // El stock de cada sucursal es independiente.
    await t.request('PUT', `/api/weeks/${mine.body.week.id}/movements`, {
      token: otherEmp.token,
      body: { changes: [{ productId: pid(206), dayIndex: 0, entrada: 50 }] },
    });
    const central = await t.request('GET', `/api/weeks/${week.id}`, { token: employee.token });
    const banana = central.body.groups.flatMap((g) => g.products).find((p) => p.code === 206);
    assert.equal(banana.days[0].entrada, 0);
  } finally {
    await t.close();
  }
});

test('el domingo a las 00:00 hora local se cierra la semana y abre la siguiente (criterio 4)', async () => {
  const { t, clock, admin, employee, branchId, pid, current, find } = await setup();
  try {
    const week = (await current()).body.week;
    const banana = pid(206);
    await t.request('PUT', `/api/weeks/${week.id}/initial-stock`, { token: admin, body: { items: [{ productId: banana, qty: 5 }] } });
    await t.request('PUT', `/api/weeks/${week.id}/movements`, {
      token: employee.token,
      body: { changes: [{ productId: banana, dayIndex: 0, entrada: 10, salida: 4 }] },
    });

    // Sábado 23:59:59 en Buenos Aires (02:59:59 UTC del domingo): sigue la misma semana.
    clock.set('2026-11-08T02:59:59Z');
    const stillSame = await current();
    assert.equal(stillSame.body.week.id, week.id);
    assert.equal(stillSame.body.week.status, 'open');
    assert.equal(stillSame.body.week.currentDayIndex, 5);

    // Domingo 00:00:00 local (03:00:00 UTC): la semana se cierra y abre la siguiente.
    clock.set('2026-11-08T03:00:00Z');
    const next = await current();
    assert.notEqual(next.body.week.id, week.id);
    assert.equal(next.body.week.startDate, '2026-11-09');
    assert.equal(next.body.week.status, 'open');
    const nb = find(next.body, 206);
    assert.equal(nb.initial, 11, 'el total final de la semana cerrada es el stock inicial de la nueva');
    assert.equal(nb.days[0].total, 11);

    const old = await t.request('GET', `/api/weeks/${week.id}`, { token: admin });
    assert.equal(old.body.week.status, 'closed');
    assert.ok(old.body.week.closedAt);
    assert.equal(old.body.week.currentDayIndex, null);
    assert.equal(find(old.body, 206).days[5].total, 11, 'la semana cerrada conserva sus datos');

    // Semana cerrada = solo lectura (criterio 3).
    const writeClosed = await t.request('PUT', `/api/weeks/${week.id}/movements`, {
      token: employee.token,
      body: { changes: [{ productId: banana, dayIndex: 0, entrada: 999 }] },
    });
    assert.equal(writeClosed.status, 409);
    assert.equal(writeClosed.body.error.code, 'week_closed');
    const initClosed = await t.request('PUT', `/api/weeks/${week.id}/initial-stock`, {
      token: admin,
      body: { items: [{ productId: banana, qty: 1 }] },
    });
    assert.equal(initClosed.status, 409);
    assert.equal(find((await t.request('GET', `/api/weeks/${week.id}`, { token: admin })).body, 206).days[0].entrada, 10);

    const history = await t.request('GET', `/api/branches/${branchId}/weeks`, { token: employee.token });
    assert.equal(history.body.total, 2);
    assert.deepEqual(history.body.weeks.map((w) => [w.startDate, w.status]), [
      ['2026-11-09', 'open'],
      ['2026-11-02', 'closed'],
    ]);
    assert.equal(history.body.weeks[1].entradas, 10);
    assert.equal(history.body.weeks[1].salidas, 4);
  } finally {
    await t.close();
  }
});

test('si pasaron varias semanas sin uso, se crean y cierran las intermedias y el stock se conserva', async () => {
  const { t, clock, admin, branchId, pid, current, find } = await setup();
  try {
    const week = (await current()).body.week;
    await t.request('PUT', `/api/weeks/${week.id}/initial-stock`, { token: admin, body: { items: [{ productId: pid(206), qty: 5 }] } });

    clock.set('2026-12-01T15:00:00Z'); // martes cuatro semanas después
    const now = await current();
    assert.equal(now.body.week.startDate, '2026-11-30');
    assert.equal(find(now.body, 206).initial, 5);

    const history = await t.request('GET', `/api/branches/${branchId}/weeks?limit=2`, { token: admin });
    assert.equal(history.body.total, 5);
    assert.equal(history.body.weeks.length, 2, 'respeta el límite');
    const all = await t.request('GET', `/api/branches/${branchId}/weeks`, { token: admin });
    assert.deepEqual(all.body.weeks.map((w) => w.status), ['open', 'closed', 'closed', 'closed', 'closed']);
    const page2 = await t.request('GET', `/api/branches/${branchId}/weeks?limit=2&offset=2`, { token: admin });
    assert.deepEqual(page2.body.weeks.map((w) => w.startDate), ['2026-11-16', '2026-11-09']);
  } finally {
    await t.close();
  }
});

test('el mantenimiento programado cierra la semana aunque nadie consulte', async () => {
  const { t, clock, branchId, current } = await setup();
  try {
    await current();
    clock.set('2026-11-08T15:00:00Z'); // domingo
    const processed = runMaintenance(t.db, t.config, clock.now);
    assert.ok(processed >= 1);
    const rows = t.db.all('SELECT start_date, status FROM weeks WHERE branch_id = ? ORDER BY start_date', branchId);
    assert.deepEqual(rows.map((r) => [r.start_date, r.status]), [
      ['2026-11-02', 'closed'],
      ['2026-11-09', 'open'],
    ]);
    const again = runMaintenance(t.db, t.config, clock.now);
    assert.ok(again >= 1);
    assert.equal(t.db.get('SELECT COUNT(*) AS n FROM weeks').n, 2, 'correrlo de nuevo no duplica semanas');
    const actions = t.db.all("SELECT action FROM audit_log WHERE action LIKE 'week_%'").map((r) => r.action);
    assert.ok(actions.includes('week_close'));
    assert.ok(actions.includes('week_open'));
  } finally {
    await t.close();
  }
});

test('alertas de stock mínimo (criterio 5)', async () => {
  const { t, clock, admin, employee, branchId, pid, current } = await setup();
  try {
    const week = (await current()).body.week;
    const banana = pid(206);
    const alerts = () => t.request('GET', `/api/branches/${branchId}/alerts`, { token: employee.token });

    assert.equal((await alerts()).body.alerts.length, 0, 'sin mínimos definidos no hay alertas');

    const noEmp = await t.request('PUT', `/api/branches/${branchId}/min-stock`, {
      token: employee.token,
      body: { items: [{ productId: banana, minQty: 10 }] },
    });
    assert.equal(noEmp.status, 403);
    const set = await t.request('PUT', `/api/branches/${branchId}/min-stock`, {
      token: admin,
      body: { items: [{ productId: banana, minQty: 10 }] },
    });
    assert.equal(set.status, 200);

    const listed = await t.request('GET', `/api/branches/${branchId}/min-stock`, { token: employee.token });
    assert.equal(listed.body.items.find((i) => i.code === 206).minQty, 10);
    assert.equal(listed.body.items.find((i) => i.code === 226).minQty, null);

    let a = (await alerts()).body;
    assert.equal(a.dayIndex, 1);
    assert.equal(a.alerts.length, 1);
    assert.deepEqual([a.alerts[0].code, a.alerts[0].stock, a.alerts[0].minQty, a.alerts[0].missing], [206, 0, 10, 10]);

    const put = (change) =>
      t.request('PUT', `/api/weeks/${week.id}/movements`, { token: employee.token, body: { changes: [change] } });
    await put({ productId: banana, dayIndex: 0, entrada: 12 });
    assert.equal((await alerts()).body.alerts.length, 0, '12 ≥ 10: sin alerta');

    await put({ productId: banana, dayIndex: 1, salida: 5 }); // hoy (martes) queda en 7
    a = (await alerts()).body;
    assert.deepEqual([a.alerts[0].stock, a.alerts[0].missing], [7, 3]);

    // Movimientos de días futuros no cambian el stock de hoy.
    await put({ productId: banana, dayIndex: 4, salida: 7 });
    assert.equal((await alerts()).body.alerts[0].stock, 7);

    // El domingo se usa el stock con el que arranca la semana nueva (= total del sábado).
    clock.set('2026-11-08T15:00:00Z');
    const sunday = (await alerts()).body;
    assert.equal(sunday.alerts[0].stock, 0, 'el sábado quedó en 0 porque el viernes salieron 7');
    assert.notEqual(sunday.weekId, week.id);

    // Quitar el mínimo y desactivar el producto apagan la alerta.
    await t.request('PUT', `/api/branches/${branchId}/min-stock`, { token: admin, body: { items: [{ productId: banana, minQty: null }] } });
    assert.equal((await alerts()).body.alerts.length, 0);
    await t.request('PUT', `/api/branches/${branchId}/min-stock`, { token: admin, body: { items: [{ productId: banana, minQty: 10 }] } });
    assert.equal((await alerts()).body.alerts.length, 1);
    await t.request('PATCH', `/api/products/${banana}`, { token: admin, body: { active: false } });
    assert.equal((await alerts()).body.alerts.length, 0, 'un producto inactivo no genera alertas');
  } finally {
    await t.close();
  }
});

test('un producto con historial se puede desactivar pero no eliminar; sus datos se siguen viendo', async () => {
  const { t, admin, employee, pid, current, find } = await setup();
  try {
    const week = (await current()).body.week;
    const banana = pid(206);
    await t.request('PUT', `/api/weeks/${week.id}/movements`, {
      token: employee.token,
      body: { changes: [{ productId: banana, dayIndex: 0, entrada: 4 }] },
    });
    const del = await t.request('DELETE', `/api/products/${banana}`, { token: admin });
    assert.equal(del.status, 409);
    assert.equal(del.body.error.code, 'product_in_use');

    await t.request('PATCH', `/api/products/${banana}`, { token: admin, body: { active: false } });
    const view = (await current()).body;
    const p = find(view, 206);
    assert.ok(p, 'sigue apareciendo porque tiene datos en la semana');
    assert.equal(p.active, false);

    // Otro producto inactivo y sin datos no se muestra.
    await t.request('PATCH', `/api/products/${pid(226)}`, { token: admin, body: { active: false } });
    assert.equal(find((await current()).body, 226), undefined);
  } finally {
    await t.close();
  }
});
