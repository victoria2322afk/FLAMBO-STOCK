// Copia de seguridad consistente de la base de datos, incluso con el servidor funcionando.
//
// Uso:  npm run backup [carpeta-destino]
// Variables: DB_PATH (base a copiar), BACKUP_DIR (destino, por defecto ./backups), BACKUP_KEEP (cuántas copias conservar, 14).
//
// No se copia el archivo a mano: con SQLite en modo WAL una copia directa puede quedar incompleta.
// VACUUM INTO genera una copia íntegra y compacta de lo que está confirmado en ese momento.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/flambo.db';
const outDir = path.resolve(process.argv[2] || process.env.BACKUP_DIR || './backups');
const keep = Number.parseInt(process.env.BACKUP_KEEP || '14', 10);

if (!fs.existsSync(dbPath)) {
  console.error(`No existe la base de datos en ${path.resolve(dbPath)}. Revisá DB_PATH.`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(outDir, `flambo-${stamp}.db`);

const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

// Verificar que la copia abre y está íntegra antes de dar el trabajo por terminado.
const copy = new DatabaseSync(target, { readOnly: true });
try {
  const check = copy.prepare('PRAGMA integrity_check').get();
  if (check.integrity_check !== 'ok') throw new Error(`La copia no pasó la verificación: ${check.integrity_check}`);
} finally {
  copy.close();
}

// Conservar solo las últimas `keep` copias.
const old = fs
  .readdirSync(outDir)
  .filter((f) => /^flambo-.*\.db$/.test(f))
  .sort()
  .reverse()
  .slice(Math.max(keep, 1));
for (const f of old) fs.rmSync(path.join(outDir, f));

console.log(`Copia creada: ${target} (${fs.statSync(target).size} bytes)${old.length ? `; se borraron ${old.length} copia(s) antigua(s)` : ''}`);
