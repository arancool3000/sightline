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
/* EVERY script index.html loads, and nothing that is not one.

   This had drifted to ten of the twenty-five modules. Anything missing
   still worked, because a miss is fetched and then cached - but only
   after one online visit, so a first run that lost signal part way
   through came up broken. loader_test derives this list from index.html
   and fails when the two disagree, which is the only way a list like
   this stays true. */
const SHELL = [
  './', './index.html', './css/app.css', './manifest.json', './icon.svg',
  './js/build.js', './js/util.js', './js/settings.js', './js/wiki.js',
  './js/camera.js', './js/geo.js', './js/roads.js', './js/route.js',
  './js/map.js', './js/mapview.js', './js/scan.js', './js/codes.js',
  './js/evidence.js', './js/faces.js', './js/track.js', './js/local.js',
  './js/species.js', './js/identify.js', './js/gemini.js', './js/live.js', './js/lens.js', './js/hands.js', './js/vr.js', './js/stereo.js', './js/scribe.js', './js/captions.js',
  './js/commands.js', './js/voice.js', './js/ar.js', './js/ui.js',
  './js/app.js',
  './vendor/tf.min.js', './vendor/tf-backend-wasm.min.js', './vendor/coco-ssd.min.js',
  './vendor/mobilenet.min.js', './vendor/imagenet-classes.js'
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
