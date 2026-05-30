const CACHE_NAME = 'kaimono-v1';
const CACHE_URLS = [
  '/kaimono-app/',
  '/kaimono-app/index.html',
  '/kaimono-app/style.css',
  '/kaimono-app/app.js',
  '/kaimono-app/icon-192.png',
  '/kaimono-app/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});
