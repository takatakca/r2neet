const CACHE_PREFIX = 'r2nette-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const OFFLINE_URL = '/offline.html';
const APP_SHELL_URL = '/';
const STATIC_PATH = /^\/assets\/.+/;
const NETWORK_ONLY_PATH = /^\/(?:api\/|auth(?:\/|$)|login(?:\/|$)|logout(?:\/|$)|verify(?:\/|$)|signup(?:\/|$)|account(?:\/|$)|admin(?:\/|$)|crew(?:\/|$))/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        APP_SHELL_URL,
        OFFLINE_URL,
        '/manifest.webmanifest',
        '/assets/brand/pwa-icon.svg',
        '/assets/brand/pwa-icon-maskable.svg',
        '/assets/brand/pwa-icon-192.png',
        '/assets/brand/pwa-icon-512.png',
        '/assets/brand/pwa-icon-maskable-512.png',
      ]),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NETWORK_ONLY_PATH.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && (url.pathname === '/' || url.pathname === '/book')) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(APP_SHELL_URL, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(APP_SHELL_URL)) || (await caches.match(OFFLINE_URL))),
    );
    return;
  }

  if (!STATIC_PATH.test(url.pathname) && url.pathname !== '/manifest.webmanifest') return;
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }).catch(() => new Response('', { status: 503, statusText: 'Offline' })),
    ),
  );
});
