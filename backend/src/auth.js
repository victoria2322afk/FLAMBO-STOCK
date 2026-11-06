import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Formato: scrypt$N$r$p$salt(b64)$hash(b64) */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Hash de relleno para igualar tiempos cuando el usuario no existe.
let dummyHashPromise;
export function dummyVerify(password) {
  dummyHashPromise ||= hashPassword('relleno-para-igualar-tiempos');
  return dummyHashPromise.then((hash) => verifyPassword(password, hash));
}

const b64url = (input) => Buffer.from(input).toString('base64url');

/** Token firmado HS256 (compatible con JWT). */
export function signToken(payload, secret, ttlSeconds, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const body = { ...payload, iat, exp: iat + ttlSeconds };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Devuelve el payload si el token es válido y no venció; si no, null. */
export function verifyToken(token, secret, nowMs = Date.now()) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null;
    const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
