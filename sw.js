/* Service Worker — офлайн-кэш оболочки приложения.
   Стратегия: app shell (свой origin) — cache-first; библиотека WebLLM и её
   рантайм с CDN — stale-while-revalidate в отдельный кэш (чтобы умный разбор
   на устройстве работал офлайн). Веса модели кэширует сам WebLLM.
   Supabase/Ollama и прочее — напрямую в сеть. */
const CACHE = 'tasks-app-v17';
const CDN_CACHE = 'tasks-cdn-v1';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/db.js',
  './js/parser.js',
  './js/llm.js',
  './js/webllm.js',
  './js/speech.js',
  './js/focus.js',
  './js/sync.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// Хосты, с которых грузятся библиотека WebLLM и её wasm-рантайм.
const CDN_HOSTS = ['esm.run', 'jsdelivr.net', 'cdn.jsdelivr.net', 'esm.sh', 'unpkg.com', 'raw.githubusercontent.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== CDN_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Свой origin — cache-first (оболочка приложения)
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached))
    );
    return;
  }

  // CDN библиотеки WebLLM — кэшируем, чтобы работало офлайн
  if (CDN_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
    e.respondWith(
      caches.open(CDN_CACHE).then((c) => c.match(e.request).then((cached) => {
        const net = fetch(e.request).then((resp) => {
          if (resp && (resp.status === 200 || resp.type === 'opaque')) c.put(e.request, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || net;
      }))
    );
    return;
  }
  // Остальное (Supabase, Ollama, веса модели) — напрямую в сеть
});
