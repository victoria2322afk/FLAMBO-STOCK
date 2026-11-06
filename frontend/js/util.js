// Utilidades compartidas. Sin dependencias: corre directo en el navegador.

export const DAY_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
export const DAY_LONG = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export const MAX_QTY = 100000;

export const round3 = (n) => Math.round(n * 1000) / 1000;

const numberFormat = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 });

/** Número para mostrar: 1234.5 → "1.234,5". Evita el "-0". */
export function fmtQty(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return numberFormat.format(n === 0 ? 0 : n);
}

/** Texto para un campo de entrada: 0 queda vacío, 1.5 → "1,5". */
export function qtyToText(n) {
  if (!n) return '';
  return String(n).replace('.', ',');
}

/**
 * Interpreta lo que se escribió en un campo.
 * Vacío vale 0. Acepta coma o punto, hasta 3 decimales, y de 0 a 100000.
 * Con allowNegative admite también un signo menos al principio.
 */
export function parseQty(text, { allowNegative = false } = {}) {
  const t = String(text ?? '').trim().replace(',', '.');
  if (t === '') return { ok: true, value: 0 };
  const re = allowNegative ? /^-?\d+(\.\d{0,3})?$/ : /^\d+(\.\d{0,3})?$/;
  if (!re.test(t)) return { ok: false };
  const value = Number(t);
  if (Math.abs(value) > MAX_QTY) return { ok: false };
  return { ok: true, value: value === 0 ? 0 : value };
}

/** '2026-11-02' → '02/11' */
export function fmtShortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

/** '2026-11-02' → '02/11/2026' */
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Fecha y hora local legible a partir de un ISO UTC. */
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Minúsculas y sin tildes, para buscar sin importar acentos. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/**
 * Recalcula en el cliente los días de un producto a partir de su stock inicial y de las
 * entradas/salidas: total = inicial + entrada − salida, y el total de un día es el inicial del siguiente.
 * Es la misma regla que aplica el servidor.
 */
export function recomputeDays(initial, days) {
  let running = initial;
  return days.map((d) => {
    const total = round3(running + d.entrada - d.salida);
    const next = { initial: round3(running), entrada: d.entrada, salida: d.salida, total };
    running = total;
    return next;
  });
}

/** Acceso a localStorage que nunca lanza (modo privado, almacenamiento bloqueado o lleno). */
export const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nada que hacer */
    }
  },
  getJson(key, fallback = null) {
    const raw = store.get(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  setJson(key, value) {
    return store.set(key, JSON.stringify(value));
  },
};
