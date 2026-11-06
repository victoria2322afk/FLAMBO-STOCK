import { HttpError } from '../http.js';
import { isValidDate, addDays } from '../dates.js';

function intQuery(value, name, { def, min, max }) {
  if (value === undefined || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, 'validation_error', `${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return n;
}

function dateQuery(value, name) {
  if (value === undefined || value === '') return null;
  if (!isValidDate(value)) throw new HttpError(400, 'validation_error', `${name} debe tener formato AAAA-MM-DD.`);
  return value;
}

export function registerAuditRoutes(router, { db }) {
  // Las fechas "from" y "to" se interpretan en UTC, igual que el campo createdAt.
  router.get('/api/audit', { roles: ['admin'] }, (ctx) => {
    const limit = intQuery(ctx.query.limit, 'limit', { def: 50, min: 1, max: 200 });
    const offset = intQuery(ctx.query.offset, 'offset', { def: 0, min: 0, max: 1_000_000 });
    const userId = intQuery(ctx.query.userId, 'userId', { def: null, min: 1, max: 1_000_000_000 });
    const branchId = intQuery(ctx.query.branchId, 'branchId', { def: null, min: 1, max: 1_000_000_000 });
    const from = dateQuery(ctx.query.from, 'from');
    const to = dateQuery(ctx.query.to, 'to');
    const action = ctx.query.action ? String(ctx.query.action).slice(0, 60) : null;

    const where = [];
    const params = [];
    if (userId !== null) { where.push('a.user_id = ?'); params.push(userId); }
    if (branchId !== null) { where.push('a.branch_id = ?'); params.push(branchId); }
    if (action) { where.push('a.action = ?'); params.push(action); }
    if (from) { where.push('a.created_at >= ?'); params.push(`${from}T00:00:00.000Z`); }
    if (to) { where.push('a.created_at < ?'); params.push(`${addDays(to, 1)}T00:00:00.000Z`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.get(`SELECT COUNT(*) AS n FROM audit_log a ${clause}`, ...params).n;
    const rows = db.all(
      `SELECT a.id, a.user_id, u.username, a.branch_id, b.name AS branch_name,
              a.action, a.entity, a.entity_id, a.detail, a.created_at
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN branches b ON b.id = a.branch_id
         ${clause}
        ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );

    return {
      total,
      entries: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        userId: r.user_id,
        username: r.username,
        branchId: r.branch_id,
        branchName: r.branch_name,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        detail: r.detail ? JSON.parse(r.detail) : null,
      })),
    };
  });
}
