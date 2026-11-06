// Service worker: deja abrir la app sin conexión.
// - Archivos de la app: primero la red (siempre lo último) y, si falla, la copia guardada.
// - La API nunca se guarda aquí: los datos sin conexión los maneja la propia app (offline.js).
// - Tipografías de Google: se guardan al usarlas la primera vez.
const VERSION = 'flambo-v1';
const SHELL = [
  './',
  'index.html',
  'config.js',
  'manifest.webmanifest',
  'css/styles.css',
  'js/main.js',
  'js/api.js',
  'js/offline.js',
  'js/ui.js',
  'js/util.js',
  'js/charts.js',
  'js/dates.js',
  'js/screens/login.js',
  'js/screens/stock.js',
  'js/screens/alerts.js',
  'js/screens/history.js',
  'js/screens/reports.js',
  'js/screens/admin.js',
  'js/screens/help.js',
  'js/vendor/react.production.min.js',
  'js/vendor/react-dom.production.min.js',
  'img/logo.png',
  'img/apple-touch-icon.png',
  'img/favicon-32.png',
  'img/icon-192.png',
  'img/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname.includes('/api/')) return; // la API va siempre directo a la red

  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !isFont) return;

  if (isFont) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const fetching = fetch(req)
          .then((res) => {
            cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || fetching;
      }),
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === 'navigate') return (await caches.match('index.html')) || (await caches.match('./'));
        return Response.error();
      }),
  );
});
