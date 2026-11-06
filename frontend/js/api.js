import { store } from './util.js';

const config = window.FLAMBO_CONFIG || {};
// Vacío = el backend sirve también el frontend (mismo origen). En Netlify va la URL de la API.
export const API_BASE = String(config.API_URL || '').replace(/\/+$/, '');

const TOKEN_KEY = 'flambo_token';
let token = store.get(TOKEN_KEY);
let onUnauthorized = null;

export const getToken = () => token;

export function setToken(value) {
  token = value;
  if (value) store.set(TOKEN_KEY, value);
  else store.remove(TOKEN_KEY);
}

/** Se llama cuando el servidor rechaza el token (sesión vencida o usuario dado de baja). */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** true si no hubo respuesta del servidor (sin internet o servidor caído). */
  get isNetwork() {
    return this.status === 0;
  }
}

async function send(method, path, { body, rawBody, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method, headers: h, body: payload });
  } catch {
    throw new ApiError(0, 'network', 'No hay conexión con el servidor.');
  }

  if (!res.ok) {
    let info = {};
    try {
      info = (await res.json()).error || {};
    } catch {
      /* respuesta sin JSON (por ejemplo, un error de un proxy) */
    }
    const err = new ApiError(res.status, info.code || 'error', info.message || `Error ${res.status} del servidor.`, info.details);
    if (res.status === 401 && token && path !== '/auth/login') {
      setToken(null);
      if (onUnauthorized) onUnauthorized(err);
    }
    throw err;
  }
  return res;
}

/** Pedido JSON. Devuelve el cuerpo ya interpretado. */
export async function api(method, path, options) {
  const res = await send(method, path, options);
  return res.json();
}

/** Descarga un archivo (con la sesión) y lo guarda con el nombre que indica el servidor. */
export async function download(path, fallbackName = 'descarga') {
  const res = await send('GET', path);
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const name = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

/** Sube un archivo tal cual (por ejemplo, una planilla .xlsx para importar). */
export async function upload(path, file) {
  const res = await send('POST', path, { rawBody: file, headers: { 'Content-Type': 'application/octet-stream' } });
  return res.json();
}
