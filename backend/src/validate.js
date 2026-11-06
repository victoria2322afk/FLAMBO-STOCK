import { HttpError } from './http.js';

/**
 * Validador mínimo de esquemas. Cada validador recibe (valor, ruta, errores)
 * y devuelve el valor limpio. No lanza: acumula errores.
 */

function missing(val, o, path, issues) {
  if (val === undefined) {
    if (o.default !== undefined) return { done: true, value: o.default };
    if (o.optional) return { done: true, value: undefined };
    issues.push({ path, message: 'es obligatorio' });
    return { done: true, value: undefined };
  }
  if (val === null) {
    if (o.nullable) return { done: true, value: null };
    issues.push({ path, message: 'no puede ser nulo' });
    return { done: true, value: undefined };
  }
  return { done: false };
}

export const s = {
  str(o = {}) {
    return (val, path, issues) => {
      const m = missing(val, o, path, issues);
      if (m.done) return m.value;
      if (typeof val !== 'string') {
        issues.push({ path, message: 'debe ser texto' });
        return undefined;
      }
      const out = o.trim === false ? val : val.trim();
      if (out.length < (o.min ?? 0)) {
        issues.push({ path, message: o.min === 1 ? 'no puede estar vacío' : `debe tener al menos ${o.min} caracteres` });
        return undefined;
      }
      if (out.length > (o.max ?? 500)) {
        issues.push({ path, message: `debe tener como máximo ${o.max ?? 500} caracteres` });
        return undefined;
      }
      if (o.pattern && !o.pattern.test(out)) {
        issues.push({ path, message: o.patternMessage || 'tiene un formato inválido' });
        return undefined;
      }
      return out;
    };
  },

  int(o = {}) {
    return (val, path, issues) => {
      const m = missing(val, o, path, issues);
      if (m.done) return m.value;
      const n = o.coerce && typeof val === 'string' && val.trim() !== '' ? Number(val) : val;
      if (typeof n !== 'number' || !Number.isInteger(n)) {
        issues.push({ path, message: 'debe ser un número entero' });
        return undefined;
      }
      if (o.min !== undefined && n < o.min) {
        issues.push({ path, message: `debe ser mayor o igual a ${o.min}` });
        return undefined;
      }
      if (o.max !== undefined && n > o.max) {
        issues.push({ path, message: `debe ser menor o igual a ${o.max}` });
        return undefined;
      }
      return n;
    };
  },

  /** Número decimal con hasta `decimals` decimales (3 por defecto). */
  num(o = {}) {
    return (val, path, issues) => {
      const m = missing(val, o, path, issues);
      if (m.done) return m.value;
      let n = val;
      if (typeof n === 'string' && n.trim() !== '') n = Number(n.replace(',', '.'));
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        issues.push({ path, message: 'debe ser un número' });
        return undefined;
      }
      const decimals = o.decimals ?? 3;
      const factor = 10 ** decimals;
      const rounded = Math.round(n * factor) / factor;
      if (Math.abs(rounded - n) > 1e-9) {
        issues.push({ path, message: `admite hasta ${decimals} decimales` });
        return undefined;
      }
      if (o.min !== undefined && rounded < o.min) {
        issues.push({ path, message: `debe ser mayor o igual a ${o.min}` });
        return undefined;
      }
      if (o.max !== undefined && rounded > o.max) {
        issues.push({ path, message: `debe ser menor o igual a ${o.max}` });
        return undefined;
      }
      return rounded;
    };
  },

  bool(o = {}) {
    return (val, path, issues) => {
      const m = missing(val, o, path, issues);
      if (m.done) return m.value;
      if (typeof val !== 'boolean') {
        issues.push({ path, message: 'debe ser verdadero o falso' });
        return undefined;
      }
      return val;
    };
  },

  oneOf(values, o = {}) {
    return (val, path, issues) => {
      const m = missing(val, o, path, issues);
      if (m.done) return m.value;
      if (!values.includes(val)) {
        issues.push({ path, message: `debe ser uno de: ${values.join(', ')}` });
        return undefined;
      }
      return val;
    };
  },

  array(item, o = {}) {
    return (val, path, issues) => {
      const m = missing(val, o, path, issues);
      if (m.done) return m.value;
      if (!Array.isArray(val)) {
        issues.push({ path, message: 'debe ser una lista' });
        return undefined;
      }
      if (val.length < (o.min ?? 0)) {
        issues.push({ path, message: `debe tener al menos ${o.min} elementos` });
        return undefined;
      }
      if (val.length > (o.max ?? 1000)) {
        issues.push({ path, message: `debe tener como máximo ${o.max ?? 1000} elementos` });
        return undefined;
      }
      return val.map((v, i) => item(v, `${path}[${i}]`, issues));
    };
  },

  obj(shape, o = {}) {
    return (val, path, issues) => {
      const m = missing(val, o, path, issues);
      if (m.done) return m.value;
      if (typeof val !== 'object' || Array.isArray(val)) {
        issues.push({ path, message: 'debe ser un objeto' });
        return undefined;
      }
      const out = {};
      for (const [key, validator] of Object.entries(shape)) {
        const r = validator(val[key], path ? `${path}.${key}` : key, issues);
        if (r !== undefined) out[key] = r;
      }
      return out;
    };
  },
};

/** Valida `input` contra `schema`. Lanza HttpError 400 si hay problemas. */
export function parse(schema, input) {
  const issues = [];
  const out = schema(input, '', issues);
  if (issues.length > 0) {
    const first = issues[0];
    const where = first.path ? `${first.path} ` : '';
    throw new HttpError(400, 'validation_error', `${where}${first.message}`.trim(), issues);
  }
  return out;
}

/** Convierte un parámetro de ruta en entero positivo o lanza 400. */
export function idParam(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new HttpError(400, 'bad_request', 'Identificador inválido.');
  }
  return n;
}

/** En un PATCH, exige que venga al menos un campo para modificar. */
export function requireFields(input) {
  if (Object.keys(input).length === 0) {
    throw new HttpError(400, 'validation_error', 'Indicá al menos un campo para modificar.');
  }
  return input;
}
