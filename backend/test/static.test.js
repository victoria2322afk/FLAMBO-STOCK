import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './helpers.js';

/** GET con la ruta tal cual (fetch normalizaría ".." antes de enviarla). */
function rawGet(baseUrl, rawPath, { method = 'GET', headers = {} } = {}) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('archivos estáticos: tipos, caché, fallback de la app y seguridad de rutas', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flambo-static-'));
  const dir = path.join(base, 'public');
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>inicio</h1>');
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'export const x = 1;');
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(base, 'secreto.txt'), 'NO DEBE SALIR');
  fs.writeFileSync(path.join(base, 'public-hermano.txt'), 'NO DEBE SALIR');

  const t = await startTestServer({ staticDir: dir });
  try {
    const home = await rawGet(t.baseUrl, '/');
    assert.equal(home.status, 200);
    assert.equal(home.body, '<h1>inicio</h1>');
    assert.match(home.headers['content-type'], /text\/html/);
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    const csp = home.headers['content-security-policy'];
    assert.match(csp, /script-src 'self'(;|$)/, 'solo scripts propios');
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, 'sin excepciones inseguras');

    const js = await rawGet(t.baseUrl, '/js/app.js');
    assert.match(js.headers['content-type'], /text\/javascript/);
    assert.equal(js.body, 'export const x = 1;');
    assert.equal((await rawGet(t.baseUrl, '/manifest.webmanifest')).headers['content-type'].split(';')[0], 'application/manifest+json');

    // Revalidación con ETag.
    const etag = js.headers.etag;
    assert.ok(etag);
    assert.equal((await rawGet(t.baseUrl, '/js/app.js', { headers: { 'If-None-Match': etag } })).status, 304);
    assert.equal(js.headers['cache-control'], 'no-cache');
    const head = await rawGet(t.baseUrl, '/js/app.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');

    // Rutas de la app (sin extensión) caen en index.html; archivos inexistentes son 404.
    const spa = await rawGet(t.baseUrl, '/historial/semana-3');
    assert.equal(spa.status, 200);
    assert.equal(spa.body, '<h1>inicio</h1>');
    assert.equal((await rawGet(t.baseUrl, '/js/no-existe.js')).status, 404);

    // Intentos de salir de la carpeta pública.
    for (const attack of [
      '/../secreto.txt',
      '/js/../../secreto.txt',
      '/%2e%2e/secreto.txt',
      '/%2e%2e%2fsecreto.txt',
      '/..%5csecreto.txt',
      '/js/%00.js',
      '/../public-hermano.txt',
      '/%',
    ]) {
      const res = await rawGet(t.baseUrl, attack);
      assert.notEqual(res.body.includes('NO DEBE SALIR'), true, `filtró contenido con ${attack}`);
      assert.ok([200, 400, 404].includes(res.status), `${attack} -> ${res.status}`);
      if (res.status === 200) assert.equal(res.body, '<h1>inicio</h1>', `${attack} solo puede caer en el index`);
    }

    // La API no queda tapada por el fallback.
    const api404 = await t.request('GET', '/api/no-existe');
    assert.equal(api404.status, 404);
    assert.equal(api404.body.error.code, 'not_found');
    assert.equal((await t.request('GET', '/api/health')).status, 200);
    // POST a una ruta de la app no se sirve como archivo.
    assert.equal((await t.request('POST', '/historial', { body: {} })).status, 404);
  } finally {
    await t.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
