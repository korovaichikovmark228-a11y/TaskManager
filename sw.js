/* Service Worker — офлайн-кэш оболочки приложения.
   Стратегия: app shell — cache-first; сеть (Supabase/CDN) — не кэшируем. */
const CACHE = 'tasks-app-v8';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/db.js',
  './js/parser.js',
  './js/llm.js',
  './js/speech.js',
  './js/focus.js',
  './js/sync.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // только GET и только свой origin кэшируем; остальное — напрямую в сеть
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) {
    return; // Supabase, esm.sh и т.п. идут в сеть как есть
  }
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((resp) => {
        // кэшируем успешные ответы своего origin
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
