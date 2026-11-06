export class HttpError extends Error {
  constructor(status, code, message, details, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Hace falta iniciar sesión.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'No tenés permiso para hacer esto.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'No se encontró lo que buscás.') => new HttpError(404, 'not_found', message);
export const conflict = (code, message) => new HttpError(409, code, message);

/** Respuesta con control total (cabeceras y cuerpo binario), por ejemplo archivos Excel. */
export class Raw {
  constructor(status, headers, body) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/** Router mínimo con parámetros de ruta (/weeks/:id). */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, opts, handler) {
    if (typeof opts === 'function') {
      handler = opts;
      opts = {};
    }
    const keys = [];
    const source = pattern.replace(/:[A-Za-z_]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    });
    this.routes.push({
      method,
      pattern,
      keys,
      re: new RegExp(`^${source}/?$`),
      opts: { auth: true, ...opts },
      handler,
    });
  }

  get(...args) { this.add('GET', ...args); }
  post(...args) { this.add('POST', ...args); }
  put(...args) { this.add('PUT', ...args); }
  patch(...args) { this.add('PATCH', ...args); }
  delete(...args) { this.add('DELETE', ...args); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          throw badRequest('La dirección tiene caracteres inválidos.');
        }
      });
      return { route, params };
    }
    return { pathMatched };
  }
}

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBytes) {
      reject(new HttpError(413, 'payload_too_large', 'El contenido enviado es demasiado grande.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let finished = false;
    req.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBytes) {
        finished = true;
        reject(new HttpError(413, 'payload_too_large', 'El contenido enviado es demasiado grande.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!finished) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!finished) reject(err);
    });
  });
}

export function parseJsonBody(buffer) {
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'El cuerpo no es un JSON válido.');
  }
}

export function sendJson(res, status, data, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res, err, extraHeaders = {}) {
  const body = { error: { code: err.code, message: err.message } };
  if (err.details) body.error.details = err.details;
  sendJson(res, err.status, body, { ...extraHeaders, ...(err.headers || {}) });
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/** Limita los intentos fallidos por clave (por ejemplo, la IP) dentro de una ventana de tiempo. */
export class FailureLimiter {
  constructor(maxAttempts, windowMs, now = () => new Date()) {
    this.max = maxAttempts;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  recent(key) {
    const cutoff = this.now().getTime() - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length > 0) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Segundos que faltan para poder reintentar, o 0 si no está bloqueado. */
  blockedFor(key) {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    const unblockAt = list[list.length - this.max] + this.windowMs;
    return Math.max(1, Math.ceil((unblockAt - this.now().getTime()) / 1000));
  }

  fail(key) {
    const list = this.recent(key);
    list.push(this.now().getTime());
    this.hits.set(key, list);
  }

  clear(key) {
    this.hits.delete(key);
  }
}
