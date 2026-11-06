import { s, parse } from '../validate.js';
import { HttpError } from '../http.js';
import { hashPassword, verifyPassword, dummyVerify, signToken } from '../auth.js';
import { audit } from '../audit.js';

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    branchId: user.branchId ?? null,
    branchName: user.branchName ?? null,
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}

const loginSchema = s.obj({
  username: s.str({ min: 1, max: 60 }),
  password: s.str({ min: 1, max: 200, trim: false }),
});

const changePasswordSchema = s.obj({
  currentPassword: s.str({ min: 1, max: 200, trim: false }),
  newPassword: s.str({ min: 8, max: 200, trim: false }),
});

export function registerAuthRoutes(router, { config, db, now, limiter }) {
  router.post('/api/auth/login', { auth: false }, async (ctx) => {
    const input = parse(loginSchema, ctx.body);

    const wait = limiter.blockedFor(ctx.ip);
    if (wait > 0) {
      throw new HttpError(
        429,
        'too_many_attempts',
        `Demasiados intentos fallidos. Probá de nuevo en ${Math.ceil(wait / 60)} minuto(s).`,
        undefined,
        { 'Retry-After': String(wait) },
      );
    }

    const row = db.get(
      `SELECT u.*, b.name AS branch_name
         FROM users u LEFT JOIN branches b ON b.id = u.branch_id
        WHERE u.username = ? AND u.active = 1`,
      input.username,
    );

    let ok = false;
    if (row) ok = await verifyPassword(input.password, row.password_hash);
    else await dummyVerify(input.password);

    if (!ok) {
      limiter.fail(ctx.ip);
      audit(db, now, {
        userId: row ? row.id : null,
        branchId: row ? row.branch_id : null,
        action: 'login_failed',
        entity: 'user',
        entityId: row ? row.id : null,
        detail: { username: input.username, ip: ctx.ip },
      });
      throw new HttpError(401, 'invalid_credentials', 'Usuario o clave incorrectos.');
    }

    limiter.clear(ctx.ip);
    audit(db, now, {
      userId: row.id,
      branchId: row.branch_id,
      action: 'login',
      entity: 'user',
      entityId: row.id,
    });

    const token = signToken({ sub: row.id, role: row.role }, config.jwtSecret, config.tokenTtlSeconds, now().getTime());
    return {
      token,
      expiresIn: config.tokenTtlSeconds,
      user: publicUser({
        id: row.id,
        username: row.username,
        name: row.name,
        role: row.role,
        branchId: row.branch_id,
        branchName: row.branch_name,
        mustChangePassword: row.must_change_password,
      }),
    };
  });

  router.get('/api/auth/me', { allowPending: true }, (ctx) => ({ user: publicUser(ctx.user) }));

  router.post('/api/auth/change-password', { allowPending: true }, async (ctx) => {
    const input = parse(changePasswordSchema, ctx.body);
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);

    if (!(await verifyPassword(input.currentPassword, row.password_hash))) {
      throw new HttpError(400, 'invalid_current_password', 'La clave actual no es correcta.');
    }
    if (input.currentPassword === input.newPassword) {
      throw new HttpError(400, 'same_password', 'La clave nueva debe ser distinta de la actual.');
    }

    const hash = await hashPassword(input.newPassword);
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hash, ctx.user.id);
    audit(db, now, {
      userId: ctx.user.id,
      branchId: ctx.user.branchId,
      action: 'change_password',
      entity: 'user',
      entityId: ctx.user.id,
    });
    return { ok: true };
  });
}
