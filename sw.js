/* Sightline service worker.

   Strategy is split by what the file IS, which matters more than it sounds:

   - App code (HTML, CSS, JS) is NETWORK-FIRST. It was cache-first, and that
     served a stale app for an hour after a deploy: the page renders from
     cache before the new worker can take over, so every release shipped one
     stale load to every returning visitor. Online you now always get the
     current build; offline you still get the cached one.

   - /vendor/* is CACHE-FIRST and versioned by URL. Those are ~1.5MB of
     immutable library files and re-fetching them on every visit would be
     pure waste.

   Model weights, the API and Wikipedia are never cached here - a stale
   answer must never be served. */

const VERSION = 'sightline-v3';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.json', './icon.svg',
  './js/util.js', './js/settings.js', './js/wiki.js', './js/camera.js',
  './js/track.js', './js/local.js', './js/identify.js', './js/captions.js',
  './js/ui.js', './js/app.js',
  './vendor/tf.min.js', './vendor/coco-ssd.min.js', './vendor/mobilenet.min.js',
  './vendor/imagenet-classes.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .catch(() => {})            // a single 404 must not block the install
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromCache(req) {
  return caches.match(req).then(hit => hit || Promise.reject(new Error('miss')));
}

function store(req, res) {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(VERSION).then(c => c.put(req, copy));
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // models, API, wiki: always live

  /* Immutable libraries: cache first. */
  if (url.pathname.indexOf('/vendor/') === 0) {
    e.respondWith(fromCache(req).catch(() => fetch(req).then(r => store(req, r))));
    return;
  }

  /* Everything else is app code: network first, cache as the offline copy. */
  e.respondWith(
    fetch(req)
      .then(r => store(req, r))
      .catch(() => fromCache(req).catch(() => caches.match('./index.html')))
  );
});
