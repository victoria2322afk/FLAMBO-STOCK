// Utilidades de fechas. Las fechas de negocio son cadenas 'YYYY-MM-DD' en la zona horaria configurada.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_DAY = 24 * 60 * 60 * 1000;

export const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Fecha local de hoy ('YYYY-MM-DD') en la zona horaria indicada. */
export function todayLocal(tzName, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tzName,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isValidDate(str) {
  if (typeof str !== 'string' || !DATE_RE.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function toUtc(str) {
  return new Date(`${str}T00:00:00Z`);
}

export function addDays(str, n) {
  return new Date(toUtc(str).getTime() + n * MS_DAY).toISOString().slice(0, 10);
}

/** Diferencia en días enteros: b - a. */
export function diffDays(a, b) {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / MS_DAY);
}

/** Lunes de la semana que contiene la fecha dada (la semana va de lunes a domingo). */
export function mondayOf(str) {
  const dow = (toUtc(str).getUTCDay() + 6) % 7; // 0 = lunes ... 6 = domingo
  return addDays(str, -dow);
}

/**
 * Índice del día vigente dentro de una semana (0 = lunes ... 5 = sábado).
 * Antes del lunes devuelve 0; el domingo o después, 5.
 */
export function currentDayIndex(startDate, today) {
  const diff = diffDays(startDate, today);
  return Math.max(0, Math.min(5, diff));
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}
