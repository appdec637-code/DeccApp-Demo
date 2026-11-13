/* DeccApp — service worker: a app abre mesmo sem internet depois da 1.ª visita. */
var CACHE = 'deccapp-web-v1';
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'web.css',
  'app.js',
  'sales-document.js',
  'system-backup.js',
  'account-access.js',
  'firebase-config.js',
  'web-api.js',
  'manifest.webmanifest',
  'icon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL).catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (key) { return key !== CACHE; }).map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Firebase e afins passam direto
  event.respondWith(
    fetch(request)
      .then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      })
      .catch(function () {
        return caches.match(request, { ignoreSearch: true }).then(function (hit) {
          return hit || caches.match('index.html');
        });
      })
  );
});
