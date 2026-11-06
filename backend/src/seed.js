import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hashPassword } from './auth.js';
import { audit } from './audit.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';

/** Catálogo original de la app anterior (códigos incluidos). */
export const CATALOG = [
  {
    group: 'Bizcochos sueltos',
    items: [
      [206, 'Banana'], [226, 'Vienes Celeste'], [227, 'Vienes Rosa'], [239, 'Moka'], [255, 'Cubano'],
      [280, 'Selva'], [290, 'Tutty'], [300, 'Molino'], [323, 'Bombón'], [328, 'Mousse'],
      [342, 'Lila'], [344, 'Celeste'], [350, 'Mama'], [351, 'Sabrosa'], [359, 'LGTB'],
      [361, 'River / Equipo'], [362, 'Arcoiris'], [363, 'Arco Violeta'], [364, 'Oreo'],
      [365, 'Oreo Choco'], [371, 'Boca'], [372, 'Argentina'], [373, 'Deliciosa'],
      [414, 'Crocante'], [418, 'Porteño Choco'], [90, 'Lemon'],
    ],
  },
  {
    group: 'Cajas x8',
    items: [
      [228, 'V. Rosa x8'], [230, 'V. Celeste x8'], [231, 'Crocante x8'], [261, 'Cubano x8'],
      [286, 'Selva x8'], [296, 'Tutty x8'], [306, 'Molino x8'], [324, 'Bombón x8'],
      [348, 'Mousse x8'], [366, 'Oreo x8'], [367, 'Oreo Ch x8'],
    ],
  },
  {
    group: 'Frola y Ricota',
    items: [
      [127, 'Frola Membrillo'], [128, 'Frola Batata'], [129, 'Frola Dulce'],
      [152, 'Ricota'], [154, 'Ricota c/ Dulce'],
    ],
  },
  { group: 'Otros', items: [[156, 'Brownie'], [165, 'Copito'], [190, 'Coco']] },
  { group: 'Cumpleaños', items: [[207, 'Cumple Blanca'], [209, 'Cumple Celeste'], [211, 'Cumple Rosa']] },
  { group: 'Premium', items: [[501, 'Premium Blanca'], [502, 'Premium Rosa'], [503, 'Premium Celeste']] },
];

/**
 * Carga datos iniciales solo en lo que esté vacío (idempotente):
 * sucursal "Casa Central", usuario admin y catálogo.
 * Devuelve qué se creó y, si la clave del admin se generó, esa clave (se muestra una sola vez).
 */
export async function seedIfEmpty(db, config, now = () => new Date()) {
  const created = { branch: false, admin: false, products: 0 };
  let generatedPassword = null;
  const stamp = now().toISOString();

  if (db.get('SELECT COUNT(*) AS n FROM branches').n === 0) {
    db.run('INSERT INTO branches (name, active, created_at) VALUES (?, 1, ?)', 'Casa Central', stamp);
    created.branch = true;
  }

  if (db.get('SELECT COUNT(*) AS n FROM users').n === 0) {
    let password = config.adminPassword;
    if (!password) {
      password = crypto.randomBytes(9).toString('base64url');
      generatedPassword = password;
    } else if (password.length < 8) {
      throw new Error('ADMIN_PASSWORD debe tener al menos 8 caracteres.');
    }
    const hash = await hashPassword(password);
    const info = db.run(
      `INSERT INTO users (username, name, password_hash, role, branch_id, active, must_change_password, created_at)
       VALUES (?, ?, ?, 'admin', NULL, 1, 1, ?)`,
      config.adminUser,
      'Administrador',
      hash,
      stamp,
    );
    audit(db, now, { userId: Number(info.lastInsertRowid), action: 'seed_admin', entity: 'user', entityId: info.lastInsertRowid });
    created.admin = true;
  }

  if (db.get('SELECT COUNT(*) AS n FROM products').n === 0) {
    db.tx(() => {
      CATALOG.forEach((g, index) => {
        const group = db.run('INSERT INTO product_groups (name, sort_order) VALUES (?, ?)', g.group, index);
        for (const [code, name] of g.items) {
          db.run(
            'INSERT INTO products (code, name, group_id, active, created_at) VALUES (?, ?, ?, 1, ?)',
            code,
            name,
            Number(group.lastInsertRowid),
            stamp,
          );
          created.products += 1;
        }
      });
    });
  }

  return { created, generatedPassword };
}

// Ejecución directa: npm run seed
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const result = await seedIfEmpty(db, config);
  console.log('Datos iniciales:', result.created);
  if (result.generatedPassword) {
    console.log(`Usuario admin: ${config.adminUser}\nClave inicial (guardala, no se vuelve a mostrar): ${result.generatedPassword}`);
  }
  db.close();
}
