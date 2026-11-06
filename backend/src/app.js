import {
  Router,
  Raw,
  HttpError,
  FailureLimiter,
  clientIp,
  forbidden,
  notFound,
  readBody,
  parseJsonBody,
  sendJson,
  sendError,
  unauthorized,
} from './http.js';
import { verifyToken } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBranchRoutes } from './routes/branches.js';
import { registerUserRoutes } from './routes/users.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerWeekRoutes } from './routes/weeks.js';
import { registerExcelRoutes } from './routes/excel.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerAuditRoutes } from './routes/audit.js';

/**
 * Crea la aplicación HTTP. No abre puertos: devuelve el `handler` para http.createServer
 * (y para las pruebas), junto con el router y el contexto compartido.
 *
 * @param {object} opts
 * @param {object} opts.config  Configuración (ver config.js)
 * @param {import('./db.js').Db} opts.db
 * @param {() => Date} [opts.now]  Reloj inyectable para pruebas
 * @param {(req, res, url) => boolean|Promise<boolean>} [opts.staticHandler]
 */
export function createApp({ config, db, now = () => new Date(), staticHandler = null }) {
  const router = new Router();
  const limiter = new FailureLimiter(config.loginMaxAttempts, config.loginWindowMs, now);
  const shared = { config, db, now, limiter };

  router.get('/api/health', { auth: false }, () => ({ status: 'ok', time: now().toISOString() }));
  registerAuthRoutes(router, shared);
  registerBranchRoutes(router, shared);
  registerUserRoutes(router, shared);
  registerCatalogRoutes(router, shared);
  registerWeekRoutes(router, shared);
  registerExcelRoutes(router, shared);
  registerReportRoutes(router, shared);
  registerAuditRoutes(router, shared);

  function authenticate(req) {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (!m) throw unauthorized();
    const payload = verifyToken(m[1], config.jwtSecret, now().getTime());
    if (!payload) throw unauthorized('La sesión venció. Volvé a iniciar sesión.');
    const row = db.get(
      `SELECT u.id, u.username, u.name, u.role, u.branch_id, u.must_change_password, b.name AS branch_name
         FROM users u LEFT JOIN branches b ON b.id = u.branch_id
        WHERE u.id = ? AND u.active = 1`,
      payload.sub,
    );
    if (!row) throw unauthorized();
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      role: row.role,
      branchId: row.branch_id,
      branchName: row.branch_name,
      mustChangePassword: Boolean(row.must_change_password),
    };
  }

  function baseHeaders(origin) {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    };
    if (config.nodeEnv === 'production') {
      headers['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
    }
    if (origin) {
      if (config.corsOrigins.includes('*')) {
        headers['Access-Control-Allow-Origin'] = '*';
      } else if (config.corsOrigins.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
      }
      if (headers['Access-Control-Allow-Origin']) {
        headers['Access-Control-Expose-Headers'] = 'Content-Disposition, Retry-After';
      }
    }
    return headers;
  }

  function mapUnexpected(err) {
    const msg = String(err?.message || '');
    if (msg.includes('UNIQUE constraint failed')) {
      return new HttpError(409, 'duplicate', 'Ya existe un registro con esos datos.');
    }
    if (msg.includes('FOREIGN KEY constraint failed')) {
      return new HttpError(409, 'invalid_reference', 'El dato está relacionado con otros registros.');
    }
    return null;
  }

  async function handler(req, res) {
    const headers = baseHeaders(req.headers.origin);
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...headers,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }

      const { route, params, pathMatched } = router.match(req.method, url.pathname);

      if (!route) {
        if (!url.pathname.startsWith('/api') && staticHandler && (req.method === 'GET' || req.method === 'HEAD')) {
          if (await staticHandler(req, res, url)) return;
        }
        if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Método no permitido.');
        throw notFound('La ruta no existe.');
      }

      const ctx = {
        req,
        res,
        params,
        query: Object.fromEntries(url.searchParams),
        body: null,
        rawBody: null,
        user: null,
        status: 200,
        ip: clientIp(req, config.trustProxy),
        config,
        db,
        now,
      };

      if (route.opts.auth) {
        ctx.user = authenticate(req);
        if (ctx.user.mustChangePassword && !route.opts.allowPending) {
          throw new HttpError(403, 'password_change_required', 'Tenés que cambiar tu clave antes de continuar.');
        }
        if (route.opts.roles && !route.opts.roles.includes(ctx.user.role)) throw forbidden();
      }

      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const buffer = await readBody(req, config.maxBodyBytes);
        if (route.opts.raw) ctx.rawBody = buffer;
        else ctx.body = parseJsonBody(buffer);
      }

      const result = await route.handler(ctx);

      if (result instanceof Raw) {
        res.writeHead(result.status, { ...headers, ...result.headers });
        res.end(result.body);
      } else {
        sendJson(res, ctx.status, result ?? { ok: true }, headers);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err, headers);
        return;
      }
      const mapped = mapUnexpected(err);
      if (mapped) {
        sendError(res, mapped, headers);
        return;
      }
      console.error(`[${new Date().toISOString()}] Error no controlado en ${req.method} ${req.url}:`, err);
      sendError(res, new HttpError(500, 'internal_error', 'Ocurrió un error inesperado.'), headers);
    }
  }

  return { handler, router, ctx: shared };
}
