/* Sightline service worker.
   Static shell is cache-first so a repeat open is instant and works offline
   (local detection still runs without a network). Anything that is not part
   of the shell - the model weights, the API, Wikipedia - goes to the network
   and is never cached here, so a stale answer can never be served. */
const VERSION = 'sightline-v1';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.json', './icon.svg',
  './js/util.js', './js/settings.js', './js/wiki.js', './js/camera.js',
  './js/track.js', './js/identify.js', './js/captions.js', './js/ui.js', './js/app.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // models, API, wiki: always live

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
