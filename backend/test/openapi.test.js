import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');

// Rutas registradas en el código: router.get('/api/...').
function codeRoutes() {
  const out = new Set();
  const files = [...fs.readdirSync(path.join(here, '../src/routes')).map((f) => `../src/routes/${f}`), '../src/app.js'];
  for (const f of files) {
    for (const m of read(f).matchAll(/router\.(get|post|put|patch|delete)\('(\/api\/[^']*)'/g)) out.add(`${m[1]} ${m[2]}`);
  }
  return out;
}

// Rutas documentadas: sin dependencias YAML, se leen por indentación.
function docRoutes() {
  const out = new Set();
  let cur = null;
  for (const line of read('../../docs/openapi.yaml').split('\n')) {
    const p = line.match(/^ {2}(\/api\/\S+):\s*$/);
    if (p) { cur = p[1].replace(/\{(\w+)\}/g, ':$1'); continue; }
    if (/^\S/.test(line)) cur = null;
    const m = cur && line.match(/^ {4}(get|post|put|patch|delete):/);
    if (m) out.add(`${m[1]} ${cur}`);
  }
  return out;
}

test('openapi.yaml documenta exactamente las rutas del servidor', () => {
  const code = codeRoutes();
  const doc = docRoutes();
  assert.ok(code.size >= 30, 'se esperaban las rutas del código');
  assert.deepEqual([...code].filter((r) => !doc.has(r)).sort(), [], 'rutas sin documentar');
  assert.deepEqual([...doc].filter((r) => !code.has(r)).sort(), [], 'rutas documentadas que no existen');
});
