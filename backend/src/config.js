import crypto from 'node:crypto';

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const toList = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Lee la configuración desde variables de entorno.
 * Recibe `env` para poder probarla sin tocar process.env.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';

  let jwtSecret = env.JWT_SECRET || '';
  if (nodeEnv === 'production' && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET es obligatorio en producción y debe tener al menos 32 caracteres.');
  }
  if (!jwtSecret) {
    // Solo desarrollo: los tokens dejan de valer al reiniciar.
    jwtSecret = crypto.randomBytes(32).toString('hex');
  }

  return {
    nodeEnv,
    port: toInt(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || './data/flambo.db',
    jwtSecret,
    tokenTtlSeconds: toInt(env.TOKEN_TTL_SECONDS, 12 * 60 * 60),
    corsOrigins: toList(env.CORS_ORIGIN),
    tzName: env.TZ_NAME || 'America/Argentina/Buenos_Aires',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    adminUser: env.ADMIN_USER || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    autoSeed: env.AUTO_SEED !== 'false',
    staticDir: env.STATIC_DIR || '',
    maxBodyBytes: toInt(env.MAX_BODY_BYTES, 2 * 1024 * 1024),
    schedulerIntervalMs: toInt(env.SCHEDULER_INTERVAL_MS, 15 * 60 * 1000),
    loginMaxAttempts: toInt(env.LOGIN_MAX_ATTEMPTS, 10),
    loginWindowMs: toInt(env.LOGIN_WINDOW_MS, 15 * 60 * 1000),
  };
}
