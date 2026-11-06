import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, ADMIN_PASSWORD } from './helpers.js';

let t;
let admin;

before(async () => {
  t = await startTestServer();
  admin = await t.adminToken();
});
after(() => t.close());

test('el admin inicial debe cambiar la clave antes de usar el resto de la API', async () => {
  const fresh = await startTestServer();
  try {
    const login = await fresh.login('admin', 'AdminPass123');
    assert.equal(login.status, 200);
    assert.equal(login.body.user.mustChangePassword, true);

    const blocked = await fresh.request('GET', '/api/branches', { token: login.body.token });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'password_change_required');

    const me = await fresh.request('GET', '/api/auth/me', { token: login.body.token });
    assert.equal(me.status, 200, '/me sigue disponible para poder cambiar la clave');

    const change = await fresh.request('POST', '/api/auth/change-password', {
      token: login.body.token,
      body: { currentPassword: 'AdminPass123', newPassword: ADMIN_PASSWORD },
    });
    assert.equal(change.status, 200);

    const ok = await fresh.request('GET', '/api/branches', { token: login.body.token });
    assert.equal(ok.status, 200);

    const oldPass = await fresh.login('admin', 'AdminPass123');
    assert.equal(oldPass.status, 401, 'la clave vieja ya no sirve');
  } finally {
    await fresh.close();
  }
});

test('sucursales: alta, duplicado, edición y permisos', async () => {
  const list = await t.request('GET', '/api/branches', { token: admin });
  assert.equal(list.body.branches.length, 1);
  assert.equal(list.body.branches[0].name, 'Casa Central');

  const created = await t.request('POST', '/api/branches', { token: admin, body: { name: 'Sucursal Norte' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.active, true);

  const dup = await t.request('POST', '/api/branches', { token: admin, body: { name: 'sucursal norte' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'duplicate_name');

  const renamed = await t.request('PATCH', `/api/branches/${created.body.id}`, { token: admin, body: { name: 'Norte' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Norte');

  const empty = await t.request('PATCH', `/api/branches/${created.body.id}`, { token: admin, body: {} });
  assert.equal(empty.status, 400);

  const missing = await t.request('PATCH', '/api/branches/9999', { token: admin, body: { name: 'X' } });
  assert.equal(missing.status, 404);

  const emp = await t.createEmployee(admin, { username: 'ana', branchId: list.body.branches[0].id });
  const own = await t.request('GET', '/api/branches', { token: emp.token });
  assert.deepEqual(own.body.branches.map((b) => b.name), ['Casa Central']);

  const otherBranch = await t.request('GET', `/api/branches/${created.body.id}`, { token: emp.token });
  assert.equal(otherBranch.status, 403);

  const noCreate = await t.request('POST', '/api/branches', { token: emp.token, body: { name: 'Hack' } });
  assert.equal(noCreate.status, 403);

  const blocked = await t.request('PATCH', `/api/branches/${list.body.branches[0].id}`, { token: admin, body: { active: false } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'branch_has_users');

  const off = await t.request('PATCH', `/api/branches/${created.body.id}`, { token: admin, body: { active: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.active, false);
});

test('usuarios: validaciones, roles y sucursal', async () => {
  const branches = (await t.request('GET', '/api/branches', { token: admin })).body.branches;
  const central = branches.find((b) => b.name === 'Casa Central');
  const inactive = branches.find((b) => !b.active);

  const badName = await t.request('POST', '/api/users', {
    token: admin,
    body: { username: 'a b', name: 'X', password: 'Password123', role: 'employee', branchId: central.id },
  });
  assert.equal(badName.status, 400);

  const shortPass = await t.request('POST', '/api/users', {
    token: admin,
    body: { username: 'bruno', name: 'Bruno', password: 'corta', role: 'employee', branchId: central.id },
  });
  assert.equal(shortPass.status, 400);

  const noBranch = await t.request('POST', '/api/users', {
    token: admin,
    body: { username: 'bruno', name: 'Bruno', password: 'Password123', role: 'employee' },
  });
  assert.equal(noBranch.status, 400);

  const inactiveBranch = await t.request('POST', '/api/users', {
    token: admin,
    body: { username: 'bruno', name: 'Bruno', password: 'Password123', role: 'employee', branchId: inactive.id },
  });
  assert.equal(inactiveBranch.status, 400);

  const ok = await t.request('POST', '/api/users', {
    token: admin,
    body: { username: 'bruno', name: 'Bruno', password: 'Password123', role: 'employee', branchId: central.id },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.mustChangePassword, true);
  assert.equal(ok.body.branchName, 'Casa Central');
  assert.equal('password_hash' in ok.body, false);

  const dup = await t.request('POST', '/api/users', {
    token: admin,
    body: { username: 'BRUNO', name: 'Otro', password: 'Password123', role: 'employee', branchId: central.id },
  });
  assert.equal(dup.status, 409);

  const adminWithBranch = await t.request('POST', '/api/users', {
    token: admin,
    body: { username: 'jefa', name: 'Jefa', password: 'Password123', role: 'admin', branchId: central.id },
  });
  assert.equal(adminWithBranch.status, 201);
  assert.equal(adminWithBranch.body.branchId, null, 'un admin no queda atado a una sucursal');

  const list = await t.request('GET', '/api/users', { token: admin });
  assert.ok(list.body.users.length >= 3);
});

test('usuarios: un admin no puede desactivarse ni quitarse el rol; reset de clave; baja inmediata', async () => {
  const users = (await t.request('GET', '/api/users', { token: admin })).body.users;
  const me = users.find((u) => u.username === 'admin');
  const bruno = users.find((u) => u.username === 'bruno');
  const jefa = users.find((u) => u.username === 'jefa');

  const self = await t.request('PATCH', `/api/users/${me.id}`, { token: admin, body: { active: false } });
  assert.equal(self.status, 409);
  assert.equal(self.body.error.code, 'cannot_modify_self');

  const demoteSelf = await t.request('PATCH', `/api/users/${me.id}`, { token: admin, body: { role: 'employee', branchId: bruno.branchId } });
  assert.equal(demoteSelf.status, 409);

  // Con otra admin activa sí se puede desactivar a "jefa"; después ya no queda margen para el último.
  const off = await t.request('PATCH', `/api/users/${jefa.id}`, { token: admin, body: { active: false } });
  assert.equal(off.status, 200);

  const toEmployeeNoBranch = await t.request('PATCH', `/api/users/${bruno.id}`, { token: admin, body: { role: 'admin' } });
  assert.equal(toEmployeeNoBranch.status, 200, 'pasar a admin no exige sucursal');
  const back = await t.request('PATCH', `/api/users/${bruno.id}`, { token: admin, body: { role: 'employee' } });
  assert.equal(back.status, 400, 'volver a empleado exige indicar sucursal');
  const backOk = await t.request('PATCH', `/api/users/${bruno.id}`, { token: admin, body: { role: 'employee', branchId: me.branchId ?? 1 } });
  assert.equal(backOk.status, 200);

  const reset = await t.request('POST', `/api/users/${bruno.id}/reset-password`, { token: admin, body: { newPassword: 'ClaveNueva123' } });
  assert.equal(reset.status, 200);
  const loginBruno = await t.login('bruno', 'ClaveNueva123');
  assert.equal(loginBruno.status, 200);
  assert.equal(loginBruno.body.user.mustChangePassword, true);

  const deactivate = await t.request('PATCH', `/api/users/${bruno.id}`, { token: admin, body: { active: false } });
  assert.equal(deactivate.status, 200);
  const stale = await t.request('GET', '/api/auth/me', { token: loginBruno.body.token });
  assert.equal(stale.status, 401, 'un usuario dado de baja pierde el acceso aunque tenga token vigente');
  const relogin = await t.login('bruno', 'ClaveNueva123');
  assert.equal(relogin.status, 401);
});

test('catálogo: empleados ven solo activos; el admin gestiona grupos y productos', async () => {
  const branchId = (await t.request('GET', '/api/branches', { token: admin })).body.branches.find((b) => b.active).id;
  const emp = await t.createEmployee(admin, { username: 'carla', branchId });

  const adminCatalog = await t.request('GET', '/api/catalog', { token: admin });
  assert.equal(adminCatalog.body.groups.length, 6);
  const total = adminCatalog.body.groups.reduce((n, g) => n + g.products.length, 0);
  assert.equal(total, 51);

  const group = await t.request('POST', '/api/groups', { token: admin, body: { name: 'Tortas' } });
  assert.equal(group.status, 201);
  const dupGroup = await t.request('POST', '/api/groups', { token: admin, body: { name: 'tortas' } });
  assert.equal(dupGroup.status, 409);

  const product = await t.request('POST', '/api/products', { token: admin, body: { code: 1000, name: 'Torta Oreo', groupId: group.body.id } });
  assert.equal(product.status, 201);
  const dupCode = await t.request('POST', '/api/products', { token: admin, body: { code: 206, name: 'Repetido', groupId: group.body.id } });
  assert.equal(dupCode.status, 409);
  assert.equal(dupCode.body.error.code, 'duplicate_code');
  const badGroup = await t.request('POST', '/api/products', { token: admin, body: { code: 1001, name: 'X', groupId: 9999 } });
  assert.equal(badGroup.status, 400);

  const notEmpty = await t.request('DELETE', `/api/groups/${group.body.id}`, { token: admin });
  assert.equal(notEmpty.status, 409);

  const hide = await t.request('PATCH', `/api/products/${product.body.id}`, { token: admin, body: { active: false } });
  assert.equal(hide.body.active, false);

  const empCatalog = await t.request('GET', '/api/catalog', { token: emp.token });
  assert.equal(empCatalog.body.groups.some((g) => g.name === 'Tortas'), false, 'un grupo sin productos activos no aparece para el empleado');
  const empIncl = await t.request('GET', '/api/catalog?includeInactive=1', { token: emp.token });
  assert.equal(empIncl.body.groups.some((g) => g.name === 'Tortas'), false, 'el empleado no puede pedir inactivos');
  const adminIncl = await t.request('GET', '/api/catalog?includeInactive=1', { token: admin });
  assert.equal(adminIncl.body.groups.some((g) => g.name === 'Tortas'), true);

  const empWrite = await t.request('POST', '/api/products', { token: emp.token, body: { code: 1002, name: 'Hack', groupId: group.body.id } });
  assert.equal(empWrite.status, 403);

  const del = await t.request('DELETE', `/api/products/${product.body.id}`, { token: admin });
  assert.equal(del.status, 200);
  const delGroup = await t.request('DELETE', `/api/groups/${group.body.id}`, { token: admin });
  assert.equal(delGroup.status, 200);
});

test('auditoría: las acciones de administración quedan registradas', async () => {
  const actions = new Set(t.db.all('SELECT action FROM audit_log').map((r) => r.action));
  for (const a of ['login', 'change_password', 'branch_create', 'branch_update', 'user_create', 'user_update',
    'user_reset_password', 'group_create', 'product_create', 'product_update', 'product_delete', 'group_delete']) {
    assert.ok(actions.has(a), `falta la acción ${a} en la auditoría`);
  }
});
