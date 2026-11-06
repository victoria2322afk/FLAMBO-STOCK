// Cola de cambios pendientes y caché de semanas para trabajar sin conexión.
import { api, ApiError } from './api.js';
import { store } from './util.js';

const MAX_BATCH = 500;
const MAX_CACHED_VIEWS = 8;

const queueKey = (userId) => `flambo_queue_${userId}`;
const viewsKey = (userId) => `flambo_views_${userId}`;
const cellKey = (c) => `${c.weekId}:${c.productId}:${c.dayIndex}`;

export function loadQueue(userId) {
  const q = store.getJson(queueKey(userId), []);
  return Array.isArray(q) ? q : [];
}

function saveQueue(userId, queue) {
  if (queue.length === 0) store.remove(queueKey(userId));
  else store.setJson(queueKey(userId), queue);
}

/**
 * Agrega un cambio a la cola. Si ya hay uno pendiente para la misma celda
 * (semana + producto + día) se combinan: queda un solo envío con el último valor.
 */
export function enqueue(userId, change) {
  const queue = loadQueue(userId);
  const key = cellKey(change);
  const ts = new Date().toISOString();
  const existing = queue.find((c) => cellKey(c) === key);
  if (existing) {
    if (change.entrada !== undefined) existing.entrada = change.entrada;
    if (change.salida !== undefined) existing.salida = change.salida;
    existing.ts = ts;
  } else {
    const entry = { weekId: change.weekId, productId: change.productId, dayIndex: change.dayIndex, ts };
    if (change.entrada !== undefined) entry.entrada = change.entrada;
    if (change.salida !== undefined) entry.salida = change.salida;
    queue.push(entry);
  }
  saveQueue(userId, queue);
  return queue.length;
}

export const pendingCount = (userId) => loadQueue(userId).length;

/** Superpone los cambios pendientes sobre una semana recién bajada del servidor. */
export function pendingForWeek(userId, weekId) {
  return loadQueue(userId).filter((c) => c.weekId === weekId);
}

let flushing = null;

/**
 * Envía los cambios pendientes al servidor. Nunca corre dos veces a la vez.
 * Devuelve { sent, discarded, stopped } donde `stopped` indica por qué se frenó
 * ('network', 'server' o null si terminó todo).
 */
export function flush(userId) {
  if (flushing) return flushing;
  flushing = doFlush(userId).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush(userId) {
  const result = { sent: 0, discarded: 0, stopped: null };
  const initial = loadQueue(userId);
  if (initial.length === 0) return result;

  const byWeek = new Map();
  for (const c of initial) {
    if (!byWeek.has(c.weekId)) byWeek.set(c.weekId, []);
    byWeek.get(c.weekId).push(c);
  }

  for (const [weekId, changes] of byWeek) {
    for (let i = 0; i < changes.length; i += MAX_BATCH) {
      const chunk = changes.slice(i, i + MAX_BATCH);
      const body = {
        changes: chunk.map((c) => {
          const out = { productId: c.productId, dayIndex: c.dayIndex, clientTs: c.ts };
          if (c.entrada !== undefined) out.entrada = c.entrada;
          if (c.salida !== undefined) out.salida = c.salida;
          return out;
        }),
      };
      try {
        await api('PUT', `/weeks/${weekId}/movements`, { body });
        removeSent(userId, chunk);
        result.sent += chunk.length;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.isNetwork || err.status >= 500 || err.status === 429 || err.status === 401) {
          result.stopped = err.isNetwork ? 'network' : 'server';
          return result;
        }
        // 400/403/404/409: el servidor no va a aceptar nunca este lote (semana cerrada, sin permiso…).
        removeSent(userId, chunk);
        result.discarded += chunk.length;
      }
    }
  }
  return result;
}

/** Quita de la cola lo que se envió; si la celda se volvió a editar mientras tanto, se conserva. */
function removeSent(userId, sent) {
  const sentTs = new Map(sent.map((c) => [cellKey(c), c.ts]));
  const remaining = loadQueue(userId).filter((c) => sentTs.get(cellKey(c)) !== c.ts);
  saveQueue(userId, remaining);
}

// ------------------------------------------------------------------ Caché de semanas

/** Guarda la última versión de una semana para poder verla sin conexión. */
export function cacheView(userId, view) {
  const all = store.getJson(viewsKey(userId), { order: [], views: {} });
  const id = String(view.week.id);
  all.views[id] = { view, savedAt: new Date().toISOString() };
  all.order = [id, ...all.order.filter((x) => x !== id)];
  while (all.order.length > MAX_CACHED_VIEWS) delete all.views[all.order.pop()];
  // Si no entra, se descartan las más viejas hasta que entre.
  while (!store.setJson(viewsKey(userId), all) && all.order.length > 1) delete all.views[all.order.pop()];
  const current = store.getJson(`flambo_current_${userId}`, {});
  if (view.week.status === 'open') {
    current[view.week.branchId] = view.week.id;
    store.setJson(`flambo_current_${userId}`, current);
  }
}

export function cachedView(userId, weekId) {
  const all = store.getJson(viewsKey(userId), null);
  return all?.views?.[String(weekId)] || null;
}

export function cachedCurrentView(userId, branchId) {
  const current = store.getJson(`flambo_current_${userId}`, {});
  const weekId = current[branchId];
  return weekId ? cachedView(userId, weekId) : null;
}

/** Borra todo lo guardado de un usuario (al cerrar sesión). */
export function clearUserData(userId) {
  store.remove(queueKey(userId));
  store.remove(viewsKey(userId));
  store.remove(`flambo_current_${userId}`);
}
