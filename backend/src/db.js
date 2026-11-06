import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_V1 = `
CREATE TABLE branches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  branch_id INTEGER REFERENCES branches(id),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (role = 'admin' OR branch_id IS NOT NULL)
);

CREATE TABLE product_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  code INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_id INTEGER NOT NULL REFERENCES product_groups(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE min_stock (
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_qty REAL NOT NULL CHECK (min_qty >= 0),
  PRIMARY KEY (branch_id, product_id)
);

CREATE TABLE weeks (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TEXT,
  UNIQUE (branch_id, start_date)
);
CREATE INDEX idx_weeks_branch_status ON weeks(branch_id, status);

CREATE TABLE week_initial_stock (
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (week_id, product_id)
);

CREATE TABLE movements (
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  day_index INTEGER NOT NULL CHECK (day_index BETWEEN 0 AND 5),
  entrada REAL NOT NULL DEFAULT 0 CHECK (entrada >= 0),
  salida REAL NOT NULL DEFAULT 0 CHECK (salida >= 0),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  PRIMARY KEY (week_id, product_id, day_index)
);
CREATE INDEX idx_movements_week ON movements(week_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  branch_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
`;

const MIGRATIONS = [SCHEMA_V1];

/**
 * Envoltorio mínimo sobre node:sqlite con caché de sentencias y transacciones anidadas.
 * Importante: los callbacks de `tx` deben ser síncronos.
 */
export class Db {
  constructor(file) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.cache = new Map();
    this.depth = 0;
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get(sql, ...params) {
    return this.stmt(sql).get(...params);
  }

  all(sql, ...params) {
    return this.stmt(sql).all(...params);
  }

  run(sql, ...params) {
    return this.stmt(sql).run(...params);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  tx(fn) {
    if (this.depth > 0) {
      const name = `sp${this.depth}`;
      this.depth += 1;
      this.raw.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.raw.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        this.depth -= 1;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close() {
    this.raw.close();
  }
}

export function migrate(db) {
  const { user_version: current } = db.get('PRAGMA user_version');
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    db.tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function openDb(file) {
  const db = new Db(file);
  migrate(db);
  return db;
}
