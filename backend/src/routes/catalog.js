import { s, parse, idParam, requireFields } from '../validate.js';
import { HttpError, notFound } from '../http.js';
import { audit } from '../audit.js';
import { isAdmin } from '../permissions.js';

const toProduct = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  groupId: row.group_id,
  active: Boolean(row.active),
});

const groupCreate = s.obj({
  name: s.str({ min: 1, max: 80 }),
  sortOrder: s.int({ min: 0, max: 9999, optional: true }),
});
const groupPatch = s.obj({
  name: s.str({ min: 1, max: 80, optional: true }),
  sortOrder: s.int({ min: 0, max: 9999, optional: true }),
});

const CODE = s.int({ min: 1, max: 999999 });
const productCreate = s.obj({
  code: CODE,
  name: s.str({ min: 1, max: 80 }),
  groupId: s.int({ min: 1 }),
  active: s.bool({ optional: true }),
});
const productPatch = s.obj({
  code: s.int({ min: 1, max: 999999, optional: true }),
  name: s.str({ min: 1, max: 80, optional: true }),
  groupId: s.int({ min: 1, optional: true }),
  active: s.bool({ optional: true }),
});

/** Catálogo completo agrupado. Los empleados solo ven productos activos. */
export function loadCatalog(db, { includeInactive }) {
  const groups = db.all('SELECT id, name, sort_order FROM product_groups ORDER BY sort_order, id');
  const products = db.all(
    `SELECT id, code, name, group_id, active FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY id`,
  );
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  for (const p of products) byGroup.get(p.group_id)?.push(toProduct(p));
  return groups
    .map((g) => ({ id: g.id, name: g.name, sortOrder: g.sort_order, products: byGroup.get(g.id) }))
    .filter((g) => includeInactive || g.products.length > 0);
}

export function registerCatalogRoutes(router, { db, now }) {
  router.get('/api/catalog', (ctx) => {
    const includeInactive = isAdmin(ctx.user) && ctx.query.includeInactive === '1';
    return { groups: loadCatalog(db, { includeInactive }) };
  });

  // ---- Grupos ----
  router.post('/api/groups', { roles: ['admin'] }, (ctx) => {
    const input = parse(groupCreate, ctx.body);
    if (db.get('SELECT 1 AS x FROM product_groups WHERE name = ?', input.name)) {
      throw new HttpError(409, 'duplicate_name', 'Ya existe un grupo con ese nombre.');
    }
    const order = input.sortOrder ?? db.get('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM product_groups').n;
    const info = db.run('INSERT INTO product_groups (name, sort_order) VALUES (?, ?)', input.name, order);
    const id = Number(info.lastInsertRowid);
    audit(db, now, { userId: ctx.user.id, action: 'group_create', entity: 'group', entityId: id, detail: { name: input.name } });
    ctx.status = 201;
    return { id, name: input.name, sortOrder: order, products: [] };
  });

  router.patch('/api/groups/:id', { roles: ['admin'] }, (ctx) => {
    const id = idParam(ctx.params.id);
    const input = requireFields(parse(groupPatch, ctx.body));
    const current = db.get('SELECT id, name, sort_order FROM product_groups WHERE id = ?', id);
    if (!current) throw notFound('El grupo no existe.');
    if (input.name !== undefined && db.get('SELECT 1 AS x FROM product_groups WHERE name = ? AND id <> ?', input.name, id)) {
      throw new HttpError(409, 'duplicate_name', 'Ya existe un grupo con ese nombre.');
    }
    const name = input.name ?? current.name;
    const order = input.sortOrder ?? current.sort_order;
    db.run('UPDATE product_groups SET name = ?, sort_order = ? WHERE id = ?', name, order, id);
    audit(db, now, { userId: ctx.user.id, action: 'group_update', entity: 'group', entityId: id, detail: input });
    return { id, name, sortOrder: order };
  });

  router.delete('/api/groups/:id', { roles: ['admin'] }, (ctx) => {
    const id = idParam(ctx.params.id);
    const current = db.get('SELECT id, name FROM product_groups WHERE id = ?', id);
    if (!current) throw notFound('El grupo no existe.');
    if (db.get('SELECT COUNT(*) AS n FROM products WHERE group_id = ?', id).n > 0) {
      throw new HttpError(409, 'group_not_empty', 'No se puede eliminar un grupo que tiene productos. Movelos antes a otro grupo.');
    }
    db.run('DELETE FROM product_groups WHERE id = ?', id);
    audit(db, now, { userId: ctx.user.id, action: 'group_delete', entity: 'group', entityId: id, detail: { name: current.name } });
    return { ok: true };
  });

  // ---- Productos ----
  function assertGroup(groupId) {
    if (!db.get('SELECT 1 AS x FROM product_groups WHERE id = ?', groupId)) {
      throw new HttpError(400, 'validation_error', 'El grupo indicado no existe.');
    }
  }

  function assertCodeFree(code, exceptId = 0) {
    if (db.get('SELECT 1 AS x FROM products WHERE code = ? AND id <> ?', code, exceptId)) {
      throw new HttpError(409, 'duplicate_code', `El código ${code} ya está en uso por otro producto.`);
    }
  }

  router.post('/api/products', { roles: ['admin'] }, (ctx) => {
    const input = parse(productCreate, ctx.body);
    assertGroup(input.groupId);
    assertCodeFree(input.code);
    const info = db.run(
      'INSERT INTO products (code, name, group_id, active, created_at) VALUES (?, ?, ?, ?, ?)',
      input.code,
      input.name,
      input.groupId,
      input.active === false ? 0 : 1,
      now().toISOString(),
    );
    const id = Number(info.lastInsertRowid);
    audit(db, now, { userId: ctx.user.id, action: 'product_create', entity: 'product', entityId: id, detail: { code: input.code, name: input.name } });
    ctx.status = 201;
    return toProduct(db.get('SELECT id, code, name, group_id, active FROM products WHERE id = ?', id));
  });

  router.patch('/api/products/:id', { roles: ['admin'] }, (ctx) => {
    const id = idParam(ctx.params.id);
    const input = requireFields(parse(productPatch, ctx.body));
    const current = db.get('SELECT id, code, name, group_id, active FROM products WHERE id = ?', id);
    if (!current) throw notFound('El producto no existe.');
    if (input.groupId !== undefined) assertGroup(input.groupId);
    if (input.code !== undefined) assertCodeFree(input.code, id);
    db.run(
      'UPDATE products SET code = ?, name = ?, group_id = ?, active = ? WHERE id = ?',
      input.code ?? current.code,
      input.name ?? current.name,
      input.groupId ?? current.group_id,
      input.active === undefined ? current.active : input.active ? 1 : 0,
      id,
    );
    audit(db, now, { userId: ctx.user.id, action: 'product_update', entity: 'product', entityId: id, detail: input });
    return toProduct(db.get('SELECT id, code, name, group_id, active FROM products WHERE id = ?', id));
  });

  router.delete('/api/products/:id', { roles: ['admin'] }, (ctx) => {
    const id = idParam(ctx.params.id);
    const current = db.get('SELECT id, code, name FROM products WHERE id = ?', id);
    if (!current) throw notFound('El producto no existe.');
    const used =
      db.get('SELECT COUNT(*) AS n FROM movements WHERE product_id = ?', id).n +
      db.get('SELECT COUNT(*) AS n FROM week_initial_stock WHERE product_id = ?', id).n;
    if (used > 0) {
      throw new HttpError(409, 'product_in_use', 'El producto tiene historial: no se puede eliminar, pero sí desactivar.');
    }
    db.run('DELETE FROM products WHERE id = ?', id);
    audit(db, now, { userId: ctx.user.id, action: 'product_delete', entity: 'product', entityId: id, detail: { code: current.code, name: current.name } });
    return { ok: true };
  });
}
