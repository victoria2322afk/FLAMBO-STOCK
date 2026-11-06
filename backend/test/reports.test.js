import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, makeClock } from './helpers.js';

const WEEK1 = '2026-11-03T15:00:00Z'; // martes; lunes = 2/11
const WEEK2 = '2026-11-10T15:00:00Z'; // martes siguiente; lunes = 9/11

/**
 * Datos de prueba:
 *  Casa Central, semana 1: Banana inicial 5; lun +10 −4; mar −1,5 | Vienés Celeste (226) mié +3 −2
 *  Casa Central, semana 2: Banana lun −20 | Vienés Celeste lun −1
 *  Norte, semana 2: Banana lun −100
 */
async function setup() {
  const clock = makeClock(WEEK1);
  const t = await startTestServer({ clock, env: { TOKEN_TTL_SECONDS: String(90 * 24 * 3600) } });
  const admin = await t.adminToken();
  const central = (await t.request('GET', '/api/branches', { token: admin })).body.branches[0];
  const north = (await t.request('POST', '/api/branches', { token: admin, body: { name: 'Sucursal Norte' } })).body;
  const ana = await t.createEmployee(admin, { username: 'ana', branchId: central.id });
  const beto = await t.createEmployee(admin, { username: 'beto', branchId: north.id });
  const pid = (code) => t.db.get('SELECT id FROM products WHERE code = ?', code).id;
  const currentWeek = async (branchId) =>
    (await t.request('GET', `/api/branches/${branchId}/weeks/current`, { token: admin })).body.week;
  const put = (weekId, token, changes) => t.request('PUT', `/api/weeks/${weekId}/movements`, { token, body: { changes } });

  const w1 = await currentWeek(central.id);
  await t.request('PUT', `/api/weeks/${w1.id}/initial-stock`, { token: admin, body: { items: [{ productId: pid(206), qty: 5 }] } });
  await put(w1.id, ana.token, [
    { productId: pid(206), dayIndex: 0, entrada: 10, salida: 4 },
    { productId: pid(206), dayIndex: 1, salida: 1.5 },
    { productId: pid(226), dayIndex: 2, entrada: 3, salida: 2 },
  ]);

  clock.set(WEEK2);
  const w2 = await currentWeek(central.id);
  const wn = await currentWeek(north.id);
  await put(w2.id, ana.token, [
    { productId: pid(206), dayIndex: 0, salida: 20 },
    { productId: pid(226), dayIndex: 0, salida: 1 },
  ]);
  await put(wn.id, beto.token, [{ productId: pid(206), dayIndex: 0, salida: 100 }]);
  return { t, clock, admin, central, north, ana, beto, w1, w2, wn };
}

const get = (t, path, token) => t.request('GET', path, { token });

test('resumen de la semana: entradas, salidas y stock final por producto y grupo', async () => {
  const { t, admin, ana, beto, w1 } = await setup();
  try {
    const res = await get(t, `/api/reports/week-summary?weekId=${w1.id}`, ana.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.week.startDate, '2026-11-02');
    assert.equal(res.body.week.status, 'closed');
    assert.deepEqual(res.body.totals, { entradas: 13, salidas: 7.5 });

    const group = res.body.groups.find((g) => g.name === 'Bizcochos sueltos');
    assert.deepEqual([group.entradas, group.salidas], [13, 7.5]);
    const banana = group.products.find((p) => p.code === 206);
    assert.deepEqual(
      { initial: banana.initial, entradas: banana.entradas, salidas: banana.salidas, final: banana.final },
      { initial: 5, entradas: 10, salidas: 5.5, final: 9.5 },
    );
    const vienes = group.products.find((p) => p.code === 226);
    assert.deepEqual([vienes.entradas, vienes.salidas, vienes.final], [3, 2, 1]);

    assert.equal((await get(t, `/api/reports/week-summary?weekId=${w1.id}`, beto.token)).status, 403, 'otra sucursal');
    assert.equal((await get(t, '/api/reports/week-summary', admin)).status, 400);
    assert.equal((await get(t, '/api/reports/week-summary?weekId=abc', admin)).status, 400);
    assert.equal((await get(t, '/api/reports/week-summary?weekId=99999', admin)).status, 404);
    assert.equal((await get(t, `/api/reports/week-summary?weekId=${w1.id}`)).status, 401);
  } finally {
    await t.close();
  }
});

test('productos más vendidos: por semanas, límite y alcance por sucursal', async () => {
  const { t, admin, ana, beto, central, north } = await setup();
  try {
    // Solo la semana actual de Casa Central: banana 20, vienés celeste 1.
    const one = await get(t, `/api/reports/top-products?weeks=1`, ana.token);
    assert.equal(one.status, 200);
    assert.equal(one.body.from, '2026-11-09');
    assert.deepEqual(one.body.products.map((p) => [p.code, p.salidas]), [[206, 20], [226, 1]]);

    // Cuatro semanas incluye la anterior: banana 5,5 + 20; vienés 2 + 1.
    const four = await get(t, '/api/reports/top-products?weeks=4', ana.token);
    assert.deepEqual(
      four.body.products.map((p) => [p.code, p.salidas, p.entradas]),
      [[206, 25.5, 10], [226, 3, 3]],
    );
    assert.equal(four.body.branchId, central.id, 'el empleado ve solo su sucursal');

    const limited = await get(t, '/api/reports/top-products?weeks=4&limit=1', ana.token);
    assert.equal(limited.body.products.length, 1);

    // Admin: todas las sucursales juntas, o una en particular.
    const all = await get(t, '/api/reports/top-products?weeks=4', admin);
    assert.equal(all.body.branchId, null);
    assert.equal(all.body.products.find((p) => p.code === 206).salidas, 125.5);
    const onlyNorth = await get(t, `/api/reports/top-products?weeks=4&branchId=${north.id}`, admin);
    assert.deepEqual(onlyNorth.body.products.map((p) => [p.code, p.salidas]), [[206, 100]]);

    // Empleado de Norte: solo lo suyo, y no puede pedir otra sucursal.
    const own = await get(t, '/api/reports/top-products', beto.token);
    assert.deepEqual(own.body.products.map((p) => [p.code, p.salidas]), [[206, 100]]);
    assert.equal((await get(t, `/api/reports/top-products?branchId=${central.id}`, beto.token)).status, 403);
    assert.equal((await get(t, '/api/reports/top-products?branchId=99999', admin)).status, 404);

    assert.equal((await get(t, '/api/reports/top-products?weeks=0', admin)).status, 400);
    assert.equal((await get(t, '/api/reports/top-products?weeks=53', admin)).status, 400);
    assert.equal((await get(t, '/api/reports/top-products?weeks=abc', admin)).status, 400);
    assert.equal((await get(t, '/api/reports/top-products?limit=0', admin)).status, 400);
  } finally {
    await t.close();
  }
});

test('tendencia: semana a semana y día a día, con las semanas sin datos en cero', async () => {
  const { t, admin, beto, north } = await setup();
  try {
    const res = await get(t, `/api/reports/trend?weeks=3&branchId=${(await get(t, '/api/branches', admin)).body.branches[0].id}`, admin);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.weeks.map((w) => w.startDate), ['2026-10-26', '2026-11-02', '2026-11-09']);

    const [empty, w1, w2] = res.body.weeks;
    assert.deepEqual([empty.entradas, empty.salidas], [0, 0], 'semana sin registros: ceros');
    assert.equal(empty.days.length, 6);
    assert.deepEqual([w1.entradas, w1.salidas], [13, 7.5]);
    assert.deepEqual(w1.days[0], { entradas: 10, salidas: 4 });
    assert.deepEqual(w1.days[1], { entradas: 0, salidas: 1.5 });
    assert.deepEqual(w1.days[2], { entradas: 3, salidas: 2 });
    assert.deepEqual(w1.days[5], { entradas: 0, salidas: 0 });
    assert.deepEqual([w2.entradas, w2.salidas], [0, 21]);

    // Admin sin sucursal: suma de todas. Empleado: solo la suya.
    const all = await get(t, '/api/reports/trend?weeks=1', admin);
    assert.equal(all.body.weeks[0].salidas, 121);
    const own = await get(t, '/api/reports/trend?weeks=1', beto.token);
    assert.equal(own.body.branchId, north.id);
    assert.equal(own.body.weeks[0].salidas, 100);

    const defaultWeeks = await get(t, '/api/reports/trend', admin);
    assert.equal(defaultWeeks.body.weeks.length, 8);
    assert.equal((await get(t, '/api/reports/trend?weeks=0', admin)).status, 400);
  } finally {
    await t.close();
  }
});

test('comparar semanas: diferencias por producto, ordenadas por mayor cambio en salidas', async () => {
  const { t, admin, ana, beto, w1, w2, wn } = await setup();
  try {
    const res = await get(t, `/api/reports/compare-weeks?a=${w1.id}&b=${w2.id}`, ana.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.a.startDate, '2026-11-02');
    assert.equal(res.body.b.startDate, '2026-11-09');
    assert.deepEqual([res.body.a.entradas, res.body.a.salidas], [13, 7.5]);
    assert.deepEqual([res.body.b.entradas, res.body.b.salidas], [0, 21]);

    assert.deepEqual(res.body.products.map((p) => p.code), [206, 226], 'mayor cambio primero');
    const banana = res.body.products[0];
    assert.deepEqual(banana.a, { entradas: 10, salidas: 5.5 });
    assert.deepEqual(banana.b, { entradas: 0, salidas: 20 });
    assert.equal(banana.deltaSalidas, 14.5);
    assert.equal(banana.deltaEntradas, -10);
    assert.equal(res.body.products[1].deltaSalidas, -1);
    assert.equal(res.body.products.some((p) => p.code === 239), false, 'sin actividad no aparece');

    // Mismas semanas en orden inverso invierte los signos.
    const inverse = await get(t, `/api/reports/compare-weeks?a=${w2.id}&b=${w1.id}`, ana.token);
    assert.equal(inverse.body.products[0].deltaSalidas, -14.5);

    // Se puede comparar una misma sucursal con otra siendo admin; un empleado solo con acceso a ambas.
    assert.equal((await get(t, `/api/reports/compare-weeks?a=${w2.id}&b=${wn.id}`, admin)).status, 200);
    assert.equal((await get(t, `/api/reports/compare-weeks?a=${w2.id}&b=${wn.id}`, ana.token)).status, 403);
    assert.equal((await get(t, `/api/reports/compare-weeks?a=${w1.id}&b=${w2.id}`, beto.token)).status, 403);

    assert.equal((await get(t, `/api/reports/compare-weeks?a=${w1.id}`, admin)).status, 400);
    assert.equal((await get(t, '/api/reports/compare-weeks?a=1&b=x', admin)).status, 400);
    assert.equal((await get(t, `/api/reports/compare-weeks?a=${w1.id}&b=99999`, admin)).status, 404);
  } finally {
    await t.close();
  }
});

test('auditoría: solo admin, con filtros, paginación y más nuevo primero', async () => {
  const { t, admin, ana } = await setup();
  try {
    assert.equal((await get(t, '/api/audit', ana.token)).status, 403);
    assert.equal((await get(t, '/api/audit')).status, 401);

    const all = await get(t, '/api/audit?limit=5', admin);
    assert.equal(all.status, 200);
    assert.equal(all.body.entries.length, 5);
    assert.ok(all.body.total > 5);
    const ids = all.body.entries.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'más nuevo primero');

    const page2 = await get(t, '/api/audit?limit=5&offset=5', admin);
    assert.equal(page2.body.entries[0].id < ids[4], true);

    const byAction = await get(t, '/api/audit?action=movements_update', admin);
    assert.ok(byAction.body.total >= 3);
    assert.ok(byAction.body.entries.every((e) => e.action === 'movements_update'));
    assert.equal(typeof byAction.body.entries[0].detail, 'object');
    assert.ok(byAction.body.entries[0].branchName);

    const byUser = await get(t, `/api/audit?userId=${ana.user.id}`, admin);
    assert.ok(byUser.body.entries.length > 0);
    assert.ok(byUser.body.entries.every((e) => e.userId === ana.user.id && e.username === 'ana'));

    // Fechas en UTC: lo de la semana 1 ocurrió el 2026-11-03 y lo de la semana 2 el 2026-11-10.
    const day1 = await get(t, '/api/audit?action=movements_update&from=2026-11-03&to=2026-11-03', admin);
    assert.equal(day1.body.total, 1);
    const day2 = await get(t, '/api/audit?action=movements_update&from=2026-11-10', admin);
    assert.equal(day2.body.total, 2);
    const none = await get(t, '/api/audit?action=movements_update&from=2026-12-01', admin);
    assert.equal(none.body.total, 0);

    assert.equal((await get(t, '/api/audit?from=ayer', admin)).status, 400);
    assert.equal((await get(t, '/api/audit?limit=0', admin)).status, 400);
    assert.equal((await get(t, '/api/audit?limit=201', admin)).status, 400);
    assert.equal((await get(t, '/api/audit?userId=abc', admin)).status, 400);
  } finally {
    await t.close();
  }
});
