const CACHE_NAME = 'kaimono-v3';
const CACHE_URLS = [
  '/kaimono-app/',
  '/kaimono-app/index.html',
  '/kaimono-app/style.css',
  '/kaimono-app/app.js',
  '/kaimono-app/icon-192.png',
  '/kaimono-app/icon-512.png',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
});

// 古いキャッシュを削除して即座に新バージョンを有効化
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先（最新を取得、オフライン時のみキャッシュ）
self.addEventListener('fetch', event => {
  const req = event.request;

  // 外部API（Firebase/Gemini/Places）はキャッシュせず素通し
  if (new URL(req.url).origin !== location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
