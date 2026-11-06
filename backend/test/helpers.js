import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedIfEmpty } from '../src/seed.js';
import { createStaticHandler } from '../src/static.js';

export const ADMIN_PASSWORD = 'AdminPass456';

/** Reloj controlable: los tests cambian `clock.current` para simular el paso del tiempo. */
export function makeClock(iso = '2026-11-03T15:00:00Z') {
  const clock = { current: new Date(iso) };
  clock.now = () => new Date(clock.current.getTime());
  clock.set = (value) => {
    clock.current = new Date(value);
  };
  return clock;
}

/**
 * Levanta la app con una base en memoria y un servidor HTTP en un puerto libre.
 * Devuelve utilidades para hacer pedidos y autenticarse.
 */
export async function startTestServer({ clock = makeClock(), env = {}, staticDir = null } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 't'.repeat(40),
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'AdminPass123',
    ...env,
  });
  const db = openDb(':memory:');
  await seedIfEmpty(db, config, clock.now);
  const staticHandler = staticDir ? createStaticHandler(staticDir) : null;
  const app = createApp({ config, db, now: clock.now, staticHandler });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { token, body, rawBody, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
    } else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: payload });
    const buffer = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    return {
      status: res.status,
      headers: res.headers,
      body: type.includes('application/json') ? JSON.parse(buffer.toString('utf8')) : buffer,
    };
  }

  async function login(username, password) {
    const res = await request('POST', '/api/auth/login', { body: { username, password } });
    return res;
  }

  /** Entra como admin y deja la clave cambiada (el admin inicial debe cambiarla). */
  async function adminToken() {
    const first = await login('admin', 'AdminPass123');
    const token = first.body.token;
    if (first.body.user.mustChangePassword) {
      const res = await request('POST', '/api/auth/change-password', {
        token,
        body: { currentPassword: 'AdminPass123', newPassword: ADMIN_PASSWORD },
      });
      if (res.status !== 200) throw new Error(`No se pudo cambiar la clave del admin: ${JSON.stringify(res.body)}`);
    }
    return token;
  }

  /** Crea un empleado (con clave ya cambiada) y devuelve su token y datos. */
  async function createEmployee(adminTok, { username, name = username, branchId, password = 'Empleado123' }) {
    const created = await request('POST', '/api/users', {
      token: adminTok,
      body: { username, name, password, role: 'employee', branchId },
    });
    if (created.status !== 201) throw new Error(`No se pudo crear el empleado: ${JSON.stringify(created.body)}`);
    const first = await login(username, password);
    const newPassword = `${password}x`;
    await request('POST', '/api/auth/change-password', {
      token: first.body.token,
      body: { currentPassword: password, newPassword },
    });
    return { token: first.body.token, user: created.body, password: newPassword };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { db, config, clock, request, login, adminToken, createEmployee, close, baseUrl };
}
