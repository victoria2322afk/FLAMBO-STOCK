/* Prueba de punta a punta: levanta el backend real con el frontend y lo recorre en Chromium.
 *
 * Uso (desde la raíz del proyecto):   node e2e/run.cjs
 * Requiere Playwright instalado (npm i -D playwright && npx playwright install chromium).
 * Variables opcionales: SHOTS_DIR (carpeta para capturas de pantalla), E2E_PORT.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 3950);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS_DIR || '';
const INITIAL_PASS = 'Inicial1234';
const ADMIN_PASS = 'NuevaClave123';

const results = [];
const consoleErrors = [];

function ok(cond, message) {
  if (!cond) throw new Error(message);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Date.now() - started });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n')[0]}`);
  }
}

async function startServer(dir) {
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DB_PATH: path.join(dir, 'e2e.db'),
    STATIC_DIR: path.join(ROOT, 'frontend'),
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: INITIAL_PASS,
    JWT_SECRET: 'e'.repeat(40),
    NODE_ENV: 'development',
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: path.join(ROOT, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return { child, log: () => log };
    } catch {
      /* todavía arrancando */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`El servidor no arrancó:\n${log}`);
}

async function apiAs(token, method, p, body) {
  const res = await fetch(`${BASE}/api${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function shot(page, name) {
  if (!SHOTS) return;
  // Los avisos temporales tapan contenido en la captura: se ocultan solo un instante
  // (por el estilo del elemento, que la política de seguridad permite; una etiqueta <style> no).
  const setToasts = (v) => page.evaluate((vis) => { const t = document.querySelector('.toasts'); if (t) t.style.visibility = vis; }, v);
  await setToasts('hidden');
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  await setToasts('');
}

const pill = (page) => page.locator('[data-testid=sync-pill]');
const waitPill = (page, text, timeout = 15000) => page.waitForFunction((t) => (document.querySelector('[data-testid=sync-pill]') || {}).textContent === t, text, { timeout });
const card = (page, code) => page.locator(`.product-card[data-code="${code}"]`);
const entrada = (page, code) => card(page, code).locator('input[aria-label^="Entrada"]');
const salida = (page, code) => card(page, code).locator('input[aria-label^="Salida"]');
const total = (page, code) => card(page, code).locator('output');
const nav = (page, label) => page.locator('nav button', { hasText: label }).first();

async function login(page, user, pass) {
  await page.getByPlaceholder('Usuario').fill(user);
  await page.getByPlaceholder('Clave').fill(pass);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

async function changeForcedPassword(page, current, next) {
  await page.getByText('Elegí una clave nueva').waitFor();
  const inputs = page.locator('.modal input[type=password]');
  await inputs.nth(0).fill(current);
  await inputs.nth(1).fill(next);
  await inputs.nth(2).fill(next);
  await page.getByRole('button', { name: 'Guardar clave' }).click();
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flambo-e2e-'));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer(dir);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires' });
  const page = await context.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR|fonts\.g/.test(m.text())) consoleErrors.push(`console: ${m.text()}`);
  });

  console.log('\nRecorrido de la app en Chromium (390×844, como un celular)\n');

  await step('la página carga y muestra el acceso', async () => {
    await page.goto(BASE);
    await page.getByRole('heading', { name: 'Stock Flambo' }).waitFor();
    await shot(page, '01-login');
  });

  await step('clave incorrecta: muestra el error y no entra', async () => {
    await login(page, 'admin', 'mala-clave');
    await page.getByText('Usuario o clave incorrectos.').waitFor();
  });

  await step('primer ingreso del admin: obliga a cambiar la clave', async () => {
    await login(page, 'admin', INITIAL_PASS);
    await page.getByText('Elegí una clave nueva').waitFor();
    // Clave nueva muy corta: error del lado del cliente
    const inputs = page.locator('.modal input[type=password]');
    await inputs.nth(0).fill(INITIAL_PASS);
    await inputs.nth(1).fill('corta');
    await inputs.nth(2).fill('corta');
    await page.getByRole('button', { name: 'Guardar clave' }).click();
    await page.getByText('al menos 8 caracteres').waitFor();
    await changeForcedPassword(page, INITIAL_PASS, ADMIN_PASS);
    await page.locator('.week-title').waitFor();
  });

  await step('pantalla de stock: semana, días y productos', async () => {
    const title = await page.locator('.week-title').textContent();
    ok(/Semana del \d\d\/\d\d al \d\d\/\d\d/.test(title), `título de semana raro: ${title}`);
    ok((await page.locator('.day-chip').count()) === 6, 'deben ser 6 días');
    ok((await page.locator('.day-chip.active').count()) === 1, 'un día activo');
    ok((await page.locator('.product-card').count()) === 51, 'deben verse los 51 productos');
    ok((await page.locator('#branch-select').inputValue()) !== '', 'el admin ve el selector de sucursal');
    await shot(page, '02-stock');
  });

  await step('cargar entrada y salida: el total se calcula al instante y se guarda', async () => {
    await entrada(page, 206).fill('10');
    await salida(page, 206).fill('4');
    ok((await total(page, 206).textContent()) === '6', `total esperado 6, fue ${await total(page, 206).textContent()}`);
    await waitPill(page, 'Al día');
    await salida(page, 206).fill('4,5'); // coma decimal
    ok((await total(page, 206).textContent()) === '5,5', 'con coma decimal');
    await waitPill(page, 'Al día');
    await shot(page, '03-carga');
  });

  await step('el valor sobrevive a recargar la página (está en el servidor)', async () => {
    await page.reload();
    await page.locator('.product-card').first().waitFor();
    ok((await entrada(page, 206).inputValue()) === '10', 'entrada persistida');
    ok((await salida(page, 206).inputValue()) === '4,5', 'salida persistida');
    ok((await total(page, 206).textContent()) === '5,5', 'total persistido');
  });

  await step('el total se arrastra al día siguiente (y los días futuros parten de ahí)', async () => {
    const activeBefore = await page.locator('.day-chip.active .day-name').textContent();
    ok(activeBefore !== 'Sáb', 'el test asume que hoy no es sábado');
    const chips = page.locator('.day-chip');
    const idx = await chips.evaluateAll((els) => els.findIndex((e) => e.classList.contains('active')));
    await chips.nth(idx + 1).click();
    ok((await card(page, 206).locator('.initial-note .num').textContent()) === '5,5', 'inicial del día siguiente = total de hoy');
    ok((await total(page, 206).textContent()) === '5,5', 'sin movimientos, el total se mantiene');
    await chips.nth(idx).click();
  });

  await step('valores inválidos se marcan y no se guardan', async () => {
    await entrada(page, 226).fill('abc');
    ok((await entrada(page, 226).getAttribute('aria-invalid')) === 'true', 'debe marcar el campo');
    ok((await total(page, 226).textContent()) === '0', 'el total no cambia');
    await entrada(page, 226).fill('');
    await entrada(page, 226).blur();
  });

  await step('búsqueda sin importar tildes ni mayúsculas', async () => {
    await page.getByPlaceholder('Buscar por nombre o código').fill('BOMBON');
    ok((await page.locator('.product-card').count()) >= 1, 'debe encontrar Bombón');
    ok((await card(page, 323).count()) === 1, 'Bombón (323)');
    await page.getByPlaceholder('Buscar por nombre o código').fill('zzzz');
    await page.getByText('Ningún producto coincide').waitFor();
    await page.getByPlaceholder('Buscar por nombre o código').fill('');
  });

  await step('barra de resumen suma el día', async () => {
    const values = await page.locator('.summary-item .value').allTextContents();
    ok(values[0] === '10' && values[1] === '4,5' && values[2] === '5,5', `resumen inesperado: ${values}`);
  });

  await step('admin: editar el stock inicial del lunes recalcula la semana', async () => {
    await page.locator('.day-chip').first().click();
    await card(page, 206).getByRole('button', { name: 'Editar' }).click();
    await page.locator('.modal input').fill('5');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('Stock inicial de Banana actualizado').waitFor();
    // El lunes no tiene movimientos de Banana: el total es solo el inicial.
    await page.waitForFunction(() => document.querySelector('.product-card[data-code="206"] output').textContent === '5');
    // Hoy (jueves) se arrastra: 5 + 10 − 4,5 = 10,5 → la nota de inicial de hoy ya no es 0.
    const todayIdx = await page.locator('.day-chip').evaluateAll((els) => els.findIndex((e) => e.querySelector('.today-mark')));
    await page.locator('.day-chip').nth(todayIdx).click();
    await page.waitForFunction(() => document.querySelector('.product-card[data-code="206"] output').textContent === '10,5');
  });

  await step('sin conexión: se puede cargar y los cambios quedan pendientes', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    ok((await page.evaluate(() => caches.keys())).length > 0, 'el service worker debería haber guardado la app');
    await context.setOffline(true);
    await waitPill(page, 'Sin conexión', 10000);
    await page.locator('.day-chip').first().click();
    await salida(page, 227).fill('3');
    ok((await total(page, 227).textContent()) === '-3', 'total negativo se muestra');
    await page.waitForFunction(() => (document.querySelector('[data-testid=sync-pill]') || {}).textContent.includes('1 pendiente'));
    await page.getByText('Sin conexión. Tus cambios se guardan').waitFor();
    await shot(page, '04-offline');
  });

  await step('sin conexión: la app abre desde el dispositivo y conserva lo pendiente', async () => {
    await page.reload();
    await page.locator('.product-card').first().waitFor({ timeout: 15000 });
    await page.getByText('Mostrando datos guardados').waitFor();
    await page.locator('.day-chip').first().click();
    ok((await salida(page, 227).inputValue()) === '3', 'el pendiente se ve aunque se recargó');
    await page.waitForFunction(() => (document.querySelector('[data-testid=sync-pill]') || {}).textContent.includes('1 pendiente'));
  });

  await step('al volver internet se envía solo lo pendiente', async () => {
    await context.setOffline(false);
    await waitPill(page, 'Al día', 30000);
    const token = await page.evaluate(() => localStorage.getItem('flambo_token'));
    const week = (await apiAs(token, 'GET', '/branches/1/weeks/current')).body;
    const p = week.groups.flatMap((g) => g.products).find((x) => x.code === 227);
    ok(p.days[0].salida === 3, `el servidor debería tener salida 3 el lunes, tiene ${JSON.stringify(p.days[0])}`);
    await page.getByText('Mostrando datos guardados').waitFor({ state: 'detached', timeout: 15000 });
  });

  await step('admin crea una sucursal y un empleado desde la pantalla', async () => {
    await nav(page, 'Admin').click();
    await page.getByRole('button', { name: '+ Nueva sucursal' }).click();
    await page.locator('.modal input').fill('Sucursal Norte');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('Sucursal "Sucursal Norte" creada.').waitFor();
    await page.getByRole('tab', { name: 'Usuarios' }).click();
    await page.getByRole('button', { name: '+ Nuevo usuario' }).click();
    const modal = page.locator('.modal');
    await modal.locator('input').nth(0).fill('beto');
    await modal.locator('input').nth(1).fill('Beto Pérez');
    await modal.locator('input').nth(2).fill('Temporal123');
    await modal.locator('select').nth(1).selectOption({ label: 'Sucursal Norte' });
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('Usuario "beto" creado.').waitFor();
    await shot(page, '05-admin-usuarios');
  });

  await step('admin: catálogo — crear producto, no eliminar uno con historial', async () => {
    await page.getByRole('tab', { name: 'Catálogo' }).click();
    await page.getByRole('button', { name: '+ Producto' }).click();
    const modal = page.locator('.modal');
    await modal.locator('input').nth(0).fill('950');
    await modal.locator('input').nth(1).fill('Torta de prueba');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('Producto "Torta de prueba" creado').waitFor();
    // Banana ya tiene movimientos: eliminarla debe fallar con un mensaje claro.
    await page.getByPlaceholder('Buscar producto').fill('banana');
    await page.locator('.list-row', { hasText: 'Banana' }).getByRole('button', { name: 'Editar' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Eliminar' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Eliminar' }).click();
    await page.getByText('tiene historial').first().waitFor();
    await page.getByRole('button', { name: 'Cancelar' }).click();
  });

  await step('admin: stock mínimo → aparece la alerta y la insignia', async () => {
    await page.getByRole('tab', { name: 'Stock mínimo' }).click();
    await page.getByPlaceholder('Buscar producto').fill('banana');
    await page.locator('.list-row', { hasText: 'Banana' }).locator('input').fill('50');
    await page.getByRole('button', { name: /Guardar cambios \(1\)/ }).click();
    await page.getByText('Stock mínimo guardado').waitFor();
    await nav(page, 'Alertas').click();
    await page.locator('.list-row', { hasText: 'Banana' }).waitFor();
    ok((await page.locator('nav .count').textContent()) === '1', 'insignia con 1 alerta');
    await shot(page, '06-alertas');
    await nav(page, 'Stock').click();
    await page.locator('.product-card[data-code="206"] .tag.warn').waitFor();
  });

  await step('historial y exportar a Excel', async () => {
    await nav(page, 'Historial').click();
    await page.locator('.list-row.clickable').first().waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.list-row button', { hasText: 'Excel' }).first().click()]);
    const name = download.suggestedFilename();
    ok(/^flambo-stock_Casa-Central_\d{4}-\d{2}-\d{2}\.xlsx$/.test(name), `nombre de archivo raro: ${name}`);
    const file = path.join(dir, name);
    await download.saveAs(file);
    ok(fs.statSync(file).size > 3000, 'el archivo parece vacío');
    fs.copyFileSync(file, path.join(dir, 'export.xlsx'));
    await shot(page, '07-historial');
  });

  await step('importar la planilla en la semana (sin cambios) y con errores', async () => {
    await page.locator('.list-row.clickable').first().click();
    await page.locator('.product-card').first().waitFor();
    await page.locator('input[type=file]').setInputFiles(path.join(dir, 'export.xlsx'));
    await page.getByText(/Planilla importada: 52 productos, 0 celdas cambiadas/).waitFor();
    // Un archivo que no es una planilla
    fs.writeFileSync(path.join(dir, 'malo.xlsx'), 'esto no es un excel, solo texto de relleno');
    await page.locator('input[type=file]').setInputFiles(path.join(dir, 'malo.xlsx'));
    await page.getByText('No se pudo leer la planilla').waitFor();
  });

  await step('reportes: resumen, más vendidos, tendencia y comparación', async () => {
    await nav(page, 'Reportes').click();
    await page.locator('.kpi.entrada .value').waitFor();
    ok((await page.locator('.kpi.entrada .value').textContent()) === '10', 'entradas de la semana');
    await page.getByRole('tab', { name: 'Más vendidos' }).click();
    await page.locator('svg.chart').waitFor();
    await page.getByRole('cell', { name: /Banana/ }).first().waitFor();
    await shot(page, '08-mas-vendidos');
    await page.getByRole('tab', { name: 'Tendencia' }).click();
    await page.locator('svg.chart').waitFor();
    await shot(page, '09-tendencia');
    await page.getByRole('tab', { name: 'Comparar' }).click();
    await page.getByText(/al menos dos semanas|Salidas A|Ninguna de las dos/).first().waitFor();
  });

  await step('auditoría: registra lo hecho, con filtro por acción', async () => {
    await nav(page, 'Admin').click();
    await page.getByRole('tab', { name: 'Auditoría' }).click();
    await page.locator('tbody tr').first().waitFor();
    await page.getByLabel('Filtrar por acción').selectOption('user_create');
    // Esperar a que el filtro termine de aplicarse (queda una sola fila: la del usuario creado).
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    ok((await page.locator('tbody tr').first().textContent()).includes('Usuario creado'), 'la fila es la de usuario creado');
    await shot(page, '10-auditoria');
  });

  await step('cerrar sesión; el empleado entra, cambia su clave y solo ve su sucursal', async () => {
    await page.locator('.user-btn').click();
    await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
    await page.getByRole('heading', { name: 'Stock Flambo' }).waitFor();
    await login(page, 'beto', 'Temporal123');
    await changeForcedPassword(page, 'Temporal123', 'ClaveBeto123');
    await page.locator('.week-title').waitFor();
    ok((await page.locator('.week-sub').textContent()) === 'Sucursal Norte', 've su sucursal');
    ok((await page.locator('#branch-select').count()) === 0, 'no hay selector de sucursal');
    ok((await nav(page, 'Admin').count()) === 0, 'no ve Administración');
    ok((await page.locator('.product-card').count()) === 52, 've el catálogo (incluye el producto nuevo)');
    ok((await page.locator('.product-card[data-code="206"] input[aria-label^="Salida"]').inputValue()) === '', 'el stock de Casa Central no se mezcla');
    ok((await page.getByRole('button', { name: 'Editar' }).count()) === 0, 'el empleado no puede editar el stock inicial');
    await shot(page, '11-empleado');
  });

  await step('empleado: cargar stock en su sucursal y cerrar sesión con pendientes avisa', async () => {
    await salida(page, 323).fill('2');
    await waitPill(page, 'Al día');
    await context.setOffline(true);
    await waitPill(page, 'Sin conexión', 10000);
    await salida(page, 323).fill('7');
    await page.waitForFunction(() => (document.querySelector('[data-testid=sync-pill]') || {}).textContent.includes('1 pendiente'));
    await page.locator('.user-btn').click();
    await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
    await page.getByText('Hay cambios sin enviar').waitFor();
    await page.getByRole('button', { name: 'Volver y esperar' }).click();
    await context.setOffline(false);
    await waitPill(page, 'Al día', 30000);
  });

  await step('un usuario dado de baja pierde el acceso en el acto', async () => {
    const adminLogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASS }) });
    const adminToken = (await adminLogin.json()).token;
    const users = (await apiAs(adminToken, 'GET', '/users')).body.users;
    const beto = users.find((u) => u.username === 'beto');
    await apiAs(adminToken, 'PATCH', `/users/${beto.id}`, { active: false });
    await nav(page, 'Alertas').click();
    await page.getByText('Tu sesión venció o fue cerrada').waitFor({ timeout: 15000 });
    await shot(page, '12-sesion-vencida');
  });

  await step('sin errores de JavaScript durante todo el recorrido', async () => {
    ok(consoleErrors.length === 0, `errores en consola:\n${consoleErrors.join('\n')}`);
  });

  await browser.close();
  server.child.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} pasos correctos`);
  if (failed.length) {
    console.log('\nFallaron:');
    for (const f of failed) console.log(` - ${f.name}\n   ${f.error}`);
    console.log('\nLog del servidor:\n' + server.log().split('\n').slice(-15).join('\n'));
    process.exit(1);
  }
})().catch((err) => {
  console.error('Error general del recorrido:', err);
  process.exit(2);
});
