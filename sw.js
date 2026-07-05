/* Service Worker - アプリシェルをキャッシュしてオフライン対応 */
const CACHE = 'weight-log-v10';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/parse.js',
  './js/foods.js',
  './vendor/chart.umd.js',
  './vendor/tesseract.min.js',
  './vendor/worker.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // CDN(Tesseract/Chart.js)などは cache-first で取得後キャッシュ
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // 同一オリジン or CDN を動的キャッシュ
        const cacheable = req.url.startsWith(self.location.origin) ||
          req.url.includes('cdn.jsdelivr.net') || req.url.includes('tessdata.projectnaptha.com');
        if (res && res.status === 200 && cacheable) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
