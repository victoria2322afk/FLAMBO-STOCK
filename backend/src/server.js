import http from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { seedIfEmpty } from './seed.js';
import { runMaintenance } from './services/weeks.js';
import { createStaticHandler } from './static.js';

const config = loadConfig();
const db = openDb(config.dbPath);

if (!process.env.JWT_SECRET) {
  console.warn('[aviso] JWT_SECRET no está definido: se usa una clave temporal y las sesiones se pierden al reiniciar.');
}

if (config.autoSeed) {
  const { created, generatedPassword } = await seedIfEmpty(db, config);
  if (created.admin) {
    console.log(`[inicio] Se creó el usuario admin "${config.adminUser}". Deberá cambiar la clave al ingresar.`);
    if (generatedPassword) {
      console.log(`[inicio] Clave inicial (guardala, no se vuelve a mostrar): ${generatedPassword}`);
    }
  }
}

const staticHandler = config.staticDir ? createStaticHandler(config.staticDir) : null;
if (staticHandler) console.log(`[inicio] Sirviendo el frontend desde ${config.staticDir}`);
const app = createApp({ config, db, staticHandler });
const server = http.createServer(app.handler);
server.keepAliveTimeout = 65_000;

// Cierre automático de semana: al arrancar (por si el servidor estuvo apagado un domingo)
// y luego periódicamente. Además se verifica en cada consulta, así que esto es un respaldo.
const clock = () => new Date();
runMaintenance(db, config, clock);
const maintenanceTimer = setInterval(() => runMaintenance(db, config, clock), config.schedulerIntervalMs);
maintenanceTimer.unref();

server.listen(config.port, config.host, () => {
  console.log(`[inicio] Flambo Stock escuchando en http://${config.host}:${config.port} (${config.nodeEnv})`);
});

function shutdown(signal) {
  console.log(`[cierre] ${signal} recibido, cerrando…`);
  clearInterval(maintenanceTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
