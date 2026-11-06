import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';

const run = promisify(execFile);
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'backup.js');
const node = (args, env) => run(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { env: { ...process.env, ...env } });

test('backup: copia consistente con la base en uso (WAL), verificada y con rotación', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flambo-backup-'));
  const dbFile = path.join(dir, 'datos', 'flambo.db');
  const out = path.join(dir, 'copias');

  // Base real en modo WAL, abierta (como si el servidor estuviera corriendo) y con datos recién escritos.
  const db = openDb(dbFile);
  db.run("INSERT INTO branches (name, active, created_at) VALUES ('Casa Central', 1, '2026-01-01T00:00:00Z')");
  db.run("INSERT INTO branches (name, active, created_at) VALUES ('Norte', 1, '2026-01-01T00:00:00Z')");
  assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');

  try {
    const first = await node([out], { DB_PATH: dbFile });
    assert.match(first.stdout, /Copia creada/);

    const files = fs.readdirSync(out).filter((f) => f.endsWith('.db'));
    assert.equal(files.length, 1);
    const copy = new DatabaseSync(path.join(out, files[0]), { readOnly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM branches').get().n, 2, 'la copia tiene los datos recién escritos');
    assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 1, 'conserva la versión del esquema');
    copy.close();

    // Rotación: con BACKUP_KEEP=2 quedan solo las dos más nuevas.
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 15)); // nombres distintos
      await node([out], { DB_PATH: dbFile, BACKUP_KEEP: '2' });
    }
    assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.db')).length, 2);

    // Base inexistente: falla con un mensaje claro y código de salida distinto de cero.
    await assert.rejects(node([out], { DB_PATH: path.join(dir, 'no-existe.db') }), (err) => err.code === 1 && /No existe la base de datos/.test(err.stderr));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
