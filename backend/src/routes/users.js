import { s, parse, idParam, requireFields } from '../validate.js';
import { HttpError, notFound } from '../http.js';
import { hashPassword } from '../auth.js';
import { audit } from '../audit.js';

const USER_SELECT = `
  SELECT u.id, u.username, u.name, u.role, u.branch_id, u.active, u.must_change_password, b.name AS branch_name
    FROM users u LEFT JOIN branches b ON b.id = u.branch_id`;

const toUser = (row) => ({
  id: row.id,
  username: row.username,
  name: row.name,
  role: row.role,
  branchId: row.branch_id,
  branchName: row.branch_name,
  active: Boolean(row.active),
  mustChangePassword: Boolean(row.must_change_password),
});

const USERNAME = s.str({
  min: 3,
  max: 40,
  pattern: /^[A-Za-z0-9._-]+$/,
  patternMessage: 'solo admite letras, números, punto, guion y guion bajo',
});

const createSchema = s.obj({
  username: USERNAME,
  name: s.str({ min: 1, max: 80 }),
  password: s.str({ min: 8, max: 200, trim: false }),
  role: s.oneOf(['admin', 'employee']),
  branchId: s.int({ min: 1, optional: true, nullable: true }),
});

const patchSchema = s.obj({
  name: s.str({ min: 1, max: 80, optional: true }),
  role: s.oneOf(['admin', 'employee'], { optional: true }),
  branchId: s.int({ min: 1, optional: true, nullable: true }),
  active: s.bool({ optional: true }),
});

const resetSchema = s.obj({ newPassword: s.str({ min: 8, max: 200, trim: false }) });

function activeAdminsExcept(db, userId) {
  return db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", userId).n;
}

function resolveBranch(db, role, branchId) {
  if (role === 'admin') return null;
  if (!branchId) throw new HttpError(400, 'validation_error', 'Un empleado tiene que tener una sucursal asignada.');
  const branch = db.get('SELECT id, active FROM branches WHERE id = ?', branchId);
  if (!branch) throw new HttpError(400, 'validation_error', 'La sucursal indicada no existe.');
  if (!branch.active) throw new HttpError(400, 'validation_error', 'La sucursal indicada está inactiva.');
  return branch.id;
}

export function registerUserRoutes(router, { db, now }) {
  router.get('/api/users', { roles: ['admin'] }, () => ({
    users: db.all(`${USER_SELECT} ORDER BY u.active DESC, u.name`).map(toUser),
  }));

  router.post('/api/users', { roles: ['admin'] }, async (ctx) => {
    const input = parse(createSchema, ctx.body);
    if (db.get('SELECT 1 AS x FROM users WHERE username = ?', input.username)) {
      throw new HttpError(409, 'duplicate_username', 'Ya existe un usuario con ese nombre de usuario.');
    }
    const branchId = resolveBranch(db, input.role, input.branchId);
    const hash = await hashPassword(input.password);
    const info = db.run(
      `INSERT INTO users (username, name, password_hash, role, branch_id, active, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
      input.username,
      input.name,
      hash,
      input.role,
      branchId,
      now().toISOString(),
    );
    const id = Number(info.lastInsertRowid);
    audit(db, now, {
      userId: ctx.user.id,
      branchId,
      action: 'user_create',
      entity: 'user',
      entityId: id,
      detail: { username: input.username, role: input.role },
    });
    ctx.status = 201;
    return toUser(db.get(`${USER_SELECT} WHERE u.id = ?`, id));
  });

  router.patch('/api/users/:id', { roles: ['admin'] }, (ctx) => {
    const id = idParam(ctx.params.id);
    const input = requireFields(parse(patchSchema, ctx.body));
    const current = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!current) throw notFound('El usuario no existe.');

    const role = input.role ?? current.role;
    const active = input.active === undefined ? Boolean(current.active) : input.active;

    const losesAdmin = current.role === 'admin' && current.active && (role !== 'admin' || !active);
    if (losesAdmin) {
      if (id === ctx.user.id) {
        throw new HttpError(409, 'cannot_modify_self', 'No podés quitarte el rol de admin ni desactivarte a vos mismo.');
      }
      if (activeAdminsExcept(db, id) === 0) {
        throw new HttpError(409, 'last_admin', 'Tiene que quedar al menos un admin activo.');
      }
    }

    const wantedBranch = input.branchId === undefined ? current.branch_id : input.branchId;
    const branchId = resolveBranch(db, role, wantedBranch);

    db.run(
      'UPDATE users SET name = ?, role = ?, branch_id = ?, active = ? WHERE id = ?',
      input.name ?? current.name,
      role,
      branchId,
      active ? 1 : 0,
      id,
    );
    audit(db, now, { userId: ctx.user.id, branchId, action: 'user_update', entity: 'user', entityId: id, detail: input });
    return toUser(db.get(`${USER_SELECT} WHERE u.id = ?`, id));
  });

  router.post('/api/users/:id/reset-password', { roles: ['admin'] }, async (ctx) => {
    const id = idParam(ctx.params.id);
    const input = parse(resetSchema, ctx.body);
    const target = db.get('SELECT id, branch_id FROM users WHERE id = ?', id);
    if (!target) throw notFound('El usuario no existe.');
    const hash = await hashPassword(input.newPassword);
    db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hash, id);
    audit(db, now, { userId: ctx.user.id, branchId: target.branch_id, action: 'user_reset_password', entity: 'user', entityId: id });
    return { ok: true };
  });
}
