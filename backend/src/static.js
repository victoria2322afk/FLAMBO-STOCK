import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// La app solo carga scripts propios; las tipografías vienen de Google Fonts y la API es del mismo origen.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CSP,
};

async function statOrNull(file) {
  try {
    return await fs.promises.stat(file);
  } catch {
    return null;
  }
}

/**
 * Sirve archivos estáticos desde `rootDir` (el frontend). Devuelve un manejador
 * `(req, res, url) => Promise<boolean>`: true si respondió, false si no corresponde.
 * - Nunca sale de `rootDir` (se rechazan `..`, rutas codificadas y bytes nulos).
 * - Las rutas sin extensión caen en index.html (la app es de una sola página).
 * - Usa ETag y responde 304 para que el navegador revalide sin volver a descargar.
 */
export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  return async function staticHandler(req, res, url) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (pathname.includes('\0') || pathname.includes('\\')) return false;

    let file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) return false;

    let info = await statOrNull(file);
    if (info?.isDirectory()) {
      file = path.join(file, 'index.html');
      info = await statOrNull(file);
    }
    if (!info) {
      if (path.extname(pathname)) return false; // un archivo que no existe es un 404 real
      file = path.join(root, 'index.html');
      info = await statOrNull(file);
      if (!info) return false;
    }
    if (!info.isFile()) return false;

    const ext = path.extname(file).toLowerCase();
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // revalidar siempre; con ETag es barato
      ETag: etag,
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    headers['Content-Length'] = info.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    await new Promise((resolve) => {
      const stream = fs.createReadStream(file);
      stream.on('error', () => {
        res.destroy();
        resolve();
      });
      stream.on('end', resolve);
      stream.pipe(res);
    });
    return true;
  };
}
