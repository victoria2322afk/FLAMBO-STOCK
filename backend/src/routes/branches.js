import { s, parse, idParam, requireFields } from '../validate.js';
import { HttpError, notFound } from '../http.js';
import { audit } from '../audit.js';
import { isAdmin, requireBranch } from '../permissions.js';

const toBranch = (row) => ({ id: row.id, name: row.name, active: Boolean(row.active) });

const createSchema = s.obj({ name: s.str({ min: 1, max: 80 }) });
const patchSchema = s.obj({
  name: s.str({ min: 1, max: 80, optional: true }),
  active: s.bool({ optional: true }),
});

export function registerBranchRoutes(router, { db, now }) {
  // Admin: todas (activas e inactivas). Empleado: solo la suya.
  router.get('/api/branches', (ctx) => {
    if (isAdmin(ctx.user)) {
      const rows = db.all('SELECT id, name, active FROM branches ORDER BY active DESC, name');
      return { branches: rows.map(toBranch) };
    }
    const row = db.get('SELECT id, name, active FROM branches WHERE id = ?', ctx.user.branchId);
    return { branches: row ? [toBranch(row)] : [] };
  });

  router.get('/api/branches/:id', (ctx) => {
    const branch = requireBranch(db, ctx.user, idParam(ctx.params.id));
    return toBranch(branch);
  });

  router.post('/api/branches', { roles: ['admin'] }, (ctx) => {
    const input = parse(createSchema, ctx.body);
    if (db.get('SELECT 1 AS x FROM branches WHERE name = ?', input.name)) {
      throw new HttpError(409, 'duplicate_name', 'Ya existe una sucursal con ese nombre.');
    }
    const info = db.run('INSERT INTO branches (name, active, created_at) VALUES (?, 1, ?)', input.name, now().toISOString());
    const id = Number(info.lastInsertRowid);
    audit(db, now, { userId: ctx.user.id, branchId: id, action: 'branch_create', entity: 'branch', entityId: id, detail: { name: input.name } });
    ctx.status = 201;
    return toBranch(db.get('SELECT id, name, active FROM branches WHERE id = ?', id));
  });

  router.patch('/api/branches/:id', { roles: ['admin'] }, (ctx) => {
    const id = idParam(ctx.params.id);
    const input = requireFields(parse(patchSchema, ctx.body));
    const current = db.get('SELECT id, name, active FROM branches WHERE id = ?', id);
    if (!current) throw notFound('La sucursal no existe.');

    if (input.name !== undefined) {
      const other = db.get('SELECT id FROM branches WHERE name = ? AND id <> ?', input.name, id);
      if (other) throw new HttpError(409, 'duplicate_name', 'Ya existe una sucursal con ese nombre.');
    }
    if (input.active === false && current.active) {
      const users = db.get('SELECT COUNT(*) AS n FROM users WHERE branch_id = ? AND active = 1', id).n;
      if (users > 0) {
        throw new HttpError(409, 'branch_has_users', 'No se puede desactivar: todavía tiene usuarios activos asignados.');
      }
    }

    const name = input.name ?? current.name;
    const active = input.active === undefined ? current.active : input.active ? 1 : 0;
    db.run('UPDATE branches SET name = ?, active = ? WHERE id = ?', name, active, id);
    audit(db, now, { userId: ctx.user.id, branchId: id, action: 'branch_update', entity: 'branch', entityId: id, detail: input });
    return toBranch(db.get('SELECT id, name, active FROM branches WHERE id = ?', id));
  });
}
