/* Sightline - ON-DEVICE fine-grained labelling.

   This is the realtime path, and it is the one that must never touch the
   network. A round trip is 400ms at best, so anything that waits for a
   server cannot label a live scene inside half a second - no matter how fast
   the server is.

   COCO-SSD says "there is a dog there". MobileNet (ImageNet, 1000 classes)
   says "Border Collie". Both run in this browser on the GPU, so a label
   appears within a frame or two of an object entering the scene.

   What this CANNOT do, at any speed, is name a person or a specific car
   model - that knowledge is not in a 14MB classifier. Those stay on the
   cloud tier and arrive later, replacing the local label in place. */
'use strict';

var LOCAL = (function () {

  /* fails counts CONSECUTIVE failures: any success resets it. Counting
     cumulatively left the warning stuck on after a couple of benign early
     misses, which is worse than not warning at all. */
  var net = null, loading = null, backend = '', variant = 'v2', lastErr = '', fails = 0, lastOk = 0, tries = 0, exhausted = false;
  var pad = document.createElement('canvas');
  pad.width = pad.height = 224;
  var pctx = pad.getContext('2d', { willReadFrequently: true });

  /* Below this gap between the best answer and the next, the best answer is
     a nearest neighbour rather than a match. */
  var MARGIN_SURE = 0.18;
  var MIN_SCORE = 0.22;          // below this, keep the generic COCO word
  var perFrame = 3;              // classifications allowed per detector pass
  var stats = { n: 0, total: 0, last: 0, worst: 0 };

  /* MEASURED, not assumed: on software GL a full-fat classifier costs ~327ms
     a crop and a half-width one ~143ms. Which of those a given phone can
     afford is not knowable from here, so the app measures itself on the
     device it is actually running on and steps down if it is too slow to
     keep labels inside the half-second budget. */
  var BUDGET_MS = 160;           // per classification; the rest of the budget
                                 // goes to the detector pass and the frame gap
  var alpha = 1.0;
  var stepped = false;

  function considerStepDown() {
    if (stepped || stats.n < 6) return;
    /* The vendored model IS the light one; there is nothing lighter to swap
       to, so reloading would cost a download and change nothing. */
    if (variant.indexOf('local') !== -1) { stepped = true; return; }
    var mean = stats.total / stats.n;
    if (mean <= BUDGET_MS) { stepped = true; return; }   // fast enough, stop checking
    stepped = true;
    alpha = 0.5;
    net = null;
    loading = null;
    stats = { n: 0, total: 0, last: 0, worst: 0 };
    load();                                              // reload lighter
  }

  /* ---- backend selection -------------------------------------------- */

  /* WebGL on an older iPad reported "Failed to link vertex and fragment
     shaders" and every inference fell to the CPU backend - 1fps and 2.4
     second labels, which is the app not working.

     Two answers, in order. First, ask WebGL for the simplest shaders it can
     compile: the packed kernels are what fail to link, and float32 render
     targets are the other common refusal on that hardware. Second, if WebGL
     still will not have it, go to WASM rather than straight to CPU - it is
     the same arithmetic compiled, and roughly an order of magnitude faster
     than the plain JavaScript kernels. CPU is the floor, not the fallback. */
  function tameWebgl() {
    if (!window.tf || !tf.env) return;
    var set = function (k, v) { try { tf.env().set(k, v); } catch (e) {} };
    set('WEBGL_PACK', false);
    set('WEBGL_PACK_DEPTHWISECONV', false);
    set('WEBGL_RENDER_FLOAT32_ENABLED', false);
    set('WEBGL_FORCE_F16_TEXTURES', true);
    set('WEBGL_CPU_FORWARD', true);
  }

  /* The .wasm binaries sit beside the library so nothing is fetched from a
     CDN; without this the backend asks jsdelivr for them and a device with
     no route there gets no backend at all. */
  var wasmPathsSet = false;
  function readyWasm() {
    if (wasmPathsSet || !window.tf || !tf.wasm || !tf.wasm.setWasmPaths) return;
    try { tf.wasm.setWasmPaths('vendor/wasm/'); wasmPathsSet = true; } catch (e) {}
  }

  function pickBackend() {
    if (!window.tf) return Promise.resolve('');
    tameWebgl();
    readyWasm();
    var order = [];
    try {
      if (tf.findBackend && tf.findBackend('webgpu')) order.push('webgpu');
    } catch (e) { /* an unregistered backend must not be fatal */ }
    order.push('webgl');
    try { if (tf.findBackend && tf.findBackend('wasm')) order.push('wasm'); }
    catch (e) {}
    order.push('cpu');

    function tryNext(i) {
      if (i >= order.length) {
        return Promise.resolve(tf.getBackend ? tf.getBackend() : '');
      }
      /* setBackend does not reliably return a thenable - some builds and
         some failure paths hand back a bare boolean, and calling .then on
         that is a SYNCHRONOUS TypeError that escapes load() entirely,
         leaving no error recorded anywhere. Promise.resolve normalises it. */
      var r;
      try { r = tf.setBackend(order[i]); }
      catch (e) { return tryNext(i + 1); }

      return Promise.resolve(r)
        .then(function (ok) {
          if (ok === false) return tryNext(i + 1);
          return Promise.resolve(tf.ready()).then(function () { return order[i]; });
        })
        .catch(function () { return tryNext(i + 1); });
    }

    return tryNext(0).then(function (b) {
      backend = b || (tf.getBackend ? tf.getBackend() : '') || '';
      return backend;
    });
  }

  /* Pull in the alternate tf build and see whether it completes the global.
     Resolves true only if the API we actually need has appeared. */
  var repairing = null;
  function repairTf() {
    if (repairing) return repairing;
    repairing = new Promise(function (res) {
      if (typeof document === 'undefined') return res(false);
      var sc = document.createElement('script');
      sc.src = 'vendor/tf.es2017.min.js';
      sc.async = false;
      sc.onload = function () { res(typeof (window.tf && tf.loadLayersModel) === 'function'); };
      sc.onerror = function () { res(false); };
      document.head.appendChild(sc);
      setTimeout(function () { res(typeof (window.tf && tf.loadLayersModel) === 'function'); }, 20000);
    });
    return repairing;
  }

  /* The detector needs a working tf just as much as the classifier does, and
     it was loading in PARALLEL with the repair - so it got the half-built
     library and died, which is the "detector unavailable" the owner saw.
     Both must wait for this. */
  function ensureTf() {
    if (!window.tf) return Promise.resolve(false);
    if (typeof tf.loadLayersModel === 'function') return Promise.resolve(true);
    return repairTf();
  }

  var trace = [];
  function mark(m) {
    trace.push(Math.round(performance.now()) + 'ms ' + m);
    if (trace.length > 24) trace.shift();
  }

  function load() {
    mark('load() called');
    if (net) return Promise.resolve(net);
    if (loading) return loading;

    /* This used to bail here unless window.mobilenet existed - a leftover
       from when the packaged loader was the primary path. It has not been
       for a while: loadLocal() goes straight to tf.loadLayersModel and never
       touches that global. So if the packaged library failed to attach for
       any reason, the recogniser died before trying the vendored weights
       that were sitting right there, and left no error behind, reporting
       only "not started". That is the whole bug.

       tf itself IS required, and its absence is now reported rather than
       silently swallowed. */
    if (!window.tf) {
      lastErr = 'tensorflow library did not load (vendor/tf.min.js)';
      return Promise.resolve(null);
    }
    if (!window.KH_IMAGENET) {
      lastErr = 'class names did not load (vendor/imagenet-classes.js)';
      return Promise.resolve(null);
    }

    /* tf exists but is INCOMPLETE.

       Reported from an iPad: "tf.loadLayersModel is not a function". The
       bundle is correct - it contains the Layers API and works elsewhere -
       so it must be throwing partway through its own execution, leaving the
       global assigned early but only half populated. A partially built
       library is worse than a missing one, because every guard for absence
       passes.

       The es2017 build is a separate, smaller compilation of the same
       library. Loading it over the top repairs the missing half. */
    if (typeof tf.loadLayersModel !== 'function') {
      mark('tf incomplete, repairing');
      return repairTf().then(function (ok) {
        if (!ok) {
          lastErr = 'tensorflow loaded but is incomplete (no loadLayersModel) and the ' +
                    'fallback build did not repair it';
          mark('repair failed');
          return null;
        }
        mark('tf repaired');
        return load();
      });
    }

    try {
      loading = startLoad();
    } catch (e) {
      /* A synchronous throw used to escape with nothing recorded, so the
         state fell through to "load() was never called" - describing the
         one thing that had definitely happened. */
      lastErr = 'load threw: ' + String(e && e.message || e).slice(0, 100);
      mark('threw: ' + lastErr.slice(0, 50));
      loading = null;
      return Promise.resolve(null);
    }
    return loading;
  }

  function startLoad() {
    return pickBackend()
      .then(function () {
        /* RELIABILITY FIRST, and deliberately so.
           The weights are vendored into this repo and served from our own
           origin, so identification cannot be broken by a third-party host
           being blocked, deprecated or down - which is what took it out
           twice. It also means the recogniser works fully offline.
           The remote sources remain only as a fallback if the local files
           are somehow missing, and they are strictly better models, so a
           future build may prefer them once this is proven stable. */
        return loadLocal()
          .catch(function (e) {
            lastErr = 'local weights failed (' + String(e && e.message || e).slice(0, 50) + ')';
            return loadMirror();
          })
          .catch(function (e) {
            if (!window.mobilenet) {
              throw new Error('all classifier sources failed: ' +
                String(lastErr || (e && e.message) || e).slice(0, 80));
            }
            variant = 'tfhub';
            return mobilenet.load({ version: 1, alpha: alpha });
          });
      })
      .then(function (m) {
        net = m;
        /* One warm inference so the first real object is not the one that
           pays for shader compilation. */
        pctx.fillStyle = '#808080';
        pctx.fillRect(0, 0, 224, 224);
        return net.classify(pad, 1).catch(function () { return null; });
      })
      .then(function () { lastErr = ''; mark('ready ' + variant); return net; })
      .catch(function (e) {
        net = null;
        lastErr = String(e && e.message || e).slice(0, 140);
        loading = null;              // allow a retry
        mark('failed: ' + lastErr.slice(0, 60));
        return null;
      });
  }

  /* Our own copy. No third party involved at any point. */
  function loadLocal() {
    if (!window.tf || !window.KH_IMAGENET) return Promise.reject(new Error('tf or classes missing'));
    return wrapLayers('vendor/models/mobilenet-v1-050-q/model.json', 'local');
  }

  function loadMirror() {
    if (!window.tf || !window.KH_IMAGENET) throw new Error('no classifier mirror available');
    return wrapLayers('https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_' +
                      (alpha === 0.5 ? '0.50' : '1.0') + '_224/model.json', 'mirror');
  }

  /* A LayersModel wrapped to answer like the packaged classifier, so every
     call site keeps using net.classify(canvas, k) and knows nothing about
     which source it came from. */
  function wrapLayers(url, tag) {
    return tf.loadLayersModel(url).then(function (lm) {
      variant = 'v1-' + tag;
      return {
        classify: function (canvas, k) {
          return new Promise(function (res) {
            var probs = tf.tidy(function () {
              var x = tf.browser.fromPixels(canvas).toFloat().div(127.5).sub(1).expandDims(0);
              return lm.predict(x).dataSync();
            });
            var top = [];
            for (var i = 0; i < probs.length; i++) top.push([probs[i], i]);
            top.sort(function (a, b) { return b[0] - a[0]; });
            res(top.slice(0, k || 3).map(function (p) {
              return { className: window.KH_IMAGENET[p[1]] || 'unknown', probability: p[0] };
            }));
          });
        }
      };
    });
  }

  function ready() { return !!net; }
  function lastError() { return lastErr; }
  function backendName() { return backend; }

  /* ---- label tidying -------------------------------------------------- */

  /* ImageNet class names are a mess: "tabby, tabby cat", "sports car, sport
     car", "Border collie". Take the first synonym and title-case it. */
  /* A rough category for the live readout. ImageNet has no kind field, so
     this is derived from the label itself - good enough for a one-word
     kicker, and never used for anything that matters. */
  var KINDS = [
    [/\b(dog|retriever|terrier|spaniel|hound|poodle|collie|shepherd|cat|tabby|bird|finch|owl|eagle|fish|shark|snake|lizard|frog|bear|wolf|fox|horse|cow|sheep|monkey|ape|rabbit|mouse|squirrel)\b/i, 'animal'],
    [/\b(beetle|butterfly|moth|bee|wasp|ant|spider|dragonfly|grasshopper|cricket|mantis|weevil|cicada|ladybug|centipede|scorpion)\b/i, 'insect'],
    [/\b(flower|daisy|orchid|rose|tree|oak|pine|maple|fern|moss|fungus|mushroom|corn|cabbage|broccoli|cactus|palm|yellow lady)\b/i, 'plant'],
    [/\b(car|truck|jeep|van|bus|limousine|convertible|minivan|ambulance|motorcycle|moped|bicycle|tricycle|train|locomotive|airliner|aircraft|boat|canoe|ship|tractor)\b/i, 'vehicle']
  ];
  function kindOfLabel(name) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0].test(name)) return KINDS[i][1];
    return 'object';
  }

  function tidy(s) {
    var first = String(s || '').split(',')[0].trim();
    return first.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); })
                .replace(/\bOf\b|\bThe\b|\bA\b/g, function (w) { return w.toLowerCase(); });
  }

  /* ImageNet is an object dataset, so some of its classes are scenes or
     materials rather than things. Those are worse than the COCO word. */
  var JUNK = /^(web site|envelope|book jacket|comic book|menu|packet|carton|jigsaw puzzle|crossword|velvet|wool|jean|handkerchief|bath towel|quilt|window screen|shoji|theater curtain|mosquito net|chain-link fence|picket fence|stone wall|worm fence|maze)$/i;

  /* ---- classification -------------------------------------------------- */

  /* Draw a track's crop into the 224 pad. Letterboxed rather than stretched:
     a squashed aspect ratio costs real accuracy on tall or wide subjects. */
  function drawCrop(video, box) {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return false;

    var p = 0.08;
    var px = box[2] * p, py = box[3] * p;
    var sx = U.clamp(box[0] - px, 0, vw - 1), sy = U.clamp(box[1] - py, 0, vh - 1);
    var sw = U.clamp(box[2] + px * 2, 1, vw - sx), sh = U.clamp(box[3] + py * 2, 1, vh - sy);

    var scale = Math.min(224 / sw, 224 / sh);
    var dw = Math.max(1, sw * scale), dh = Math.max(1, sh * scale);

    pctx.fillStyle = '#000';
    pctx.fillRect(0, 0, 224, 224);
    pctx.drawImage(video, sx, sy, sw, sh, (224 - dw) / 2, (224 - dh) / 2, dw, dh);
    return true;
  }

  /* Classify one track NOW. Returns a promise, but the caller does not wait
     on it - the label is written onto the track when it lands. */
  /* iOS Safari can initialise WebGL happily and then throw on the first real
     inference. Falling back only at init time left the app silently dead on
     exactly those devices, so a failing inference now demotes the backend to
     CPU once and retries. Slower, but it runs. */
  var demoted = false, gpuFails = 0;
  function demoteAndRetry(e) {
    if (demoted || !window.tf) return Promise.reject(e);
    /* Dropping to CPU costs roughly twenty times the speed - the owner's
       device ran at 1fps with 2.4s labels on it. One bad inference is not
       enough evidence; three consecutive ones is. */
    if (++gpuFails < 3) return Promise.reject(e);
    demoted = true;
    /* Down one step, not all the way to the floor. WASM is the same
       arithmetic compiled and is worth trying before the JavaScript
       kernels; the owner's iPad was landing straight on cpu. */
    var next = 'cpu';
    try { if (tf.findBackend && tf.findBackend('wasm') && backend !== 'wasm') next = 'wasm'; }
    catch (ee) {}
    lastErr = 'gpu inference failed, retrying on ' + next + ': ' + String(e && e.message || e).slice(0, 60);
    return tf.setBackend(next).then(function () {
      return tf.ready();
    }).then(function () {
      backend = next;
      if (next === 'wasm') { demoted = false; gpuFails = 0; }   // wasm may still fail; cpu is the floor
      return true;
    });
  }

  function label(video, t) {
    if (!net || t.localState === 'busy') return Promise.resolve(null);
    if (!drawCrop(video, t.raw || t.box)) return Promise.resolve(null);

    t.localState = 'busy';
    t.scan = 'scanning';
    var t0 = performance.now();

    return net.classify(pad, 3).then(function (preds) {
      var ms = performance.now() - t0;
      stats.n++; stats.total += ms; stats.last = ms;
      if (ms > stats.worst) stats.worst = ms;
      considerStepDown();

      t.localState = 'done';
      t.localAt = performance.now();
      fails = 0; gpuFails = 0; lastOk = performance.now();   // a success clears the streak

      if (!preds || !preds.length) return null;
      var top = preds[0];
      var name = tidy(top.className);

      if (top.probability < MIN_SCORE || JUNK.test(name)) {
        t.local = null;                       // keep the generic COCO word
        /* A verdict, not a silence: the target is marked dismissed with the
           reason, so the screen shows it was considered and rejected rather
           than just never labelled. */
        t.scan = 'dismissed';
        t.why = JUNK.test(name) ? 'NOT A SUBJECT' : 'LOW CONFIDENCE';
        t.settled = performance.now();
        return null;
      }

      /* HOW SURE IS IT, REALLY?

         A Maltipoo is a poodle crossed with a maltese. It is not one of the
         classifier's thousand classes and never will be, so asked to name
         one it returns its nearest neighbour - "Cocker Spaniel" - at a
         perfectly respectable confidence, and that gets written on the
         screen as a fact.

         The tell is not the top score, it is the GAP to the next answer.
         When a picture genuinely is a cocker spaniel the gap is wide; when
         it is a crossbreed the model is torn between several breeds and the
         gap collapses. So the gap is carried with the label, a narrow one
         marks it unsettled, and the runners-up are kept - for a crossbreed
         the list of breeds it resembles is the honest answer. */
      var second = preds[1] ? preds[1].probability : 0;
      t.local = {
        name: name,
        score: top.probability,
        margin: top.probability - second,
        ms: ms,
        alt: preds.slice(1).map(function (p) { return tidy(p.className); })
      };
      /* Only the cloud tier may overwrite a label it has already sharpened. */
      if (t.tier !== 'cloud') { t.label = name; t.tier = 'local'; t.unsure = t.local.margin < MARGIN_SURE; }
      t.scan = 'relevant';
      t.why = '';
      t.settled = performance.now();
      return t.local;
    }).catch(function (e) {
      t.localState = 'failed';
      t.scan = 'dismissed';
      t.why = 'SCAN FAILED';
      t.settled = performance.now();
      /* Never swallow this. A silently caught inference error is
         indistinguishable from "the app found nothing", which is precisely
         how this went undiagnosed. */
      lastErr = 'classify: ' + String(e && e.message || e).slice(0, 90);
      fails++;
      demoteAndRetry(e).catch(function () {});
      return null;
    });
  }

  /* Label every track that does not have one yet, newest first, capped so a
     crowded scene cannot blow the frame budget. */
  function sweep(video, tracks) {
    if (!net) return;
    var pending = tracks.filter(function (t) { return !t.localState || t.localState === 'stale'; });
    if (!pending.length) return;

    /* Biggest first: the thing filling the frame is what the user is
       pointing at, so it should be named before anything in the corner. */
    pending.sort(function (a, b) { return (b.box[2] * b.box[3]) - (a.box[2] * a.box[3]); });
    pending.slice(0, perFrame).forEach(function (t) { label(video, t); });
  }

  /* Re-check a track every so often: a subject turns, gets closer, or was
     first seen half out of frame. */
  function age(tracks, now) {
    tracks.forEach(function (t) {
      if (t.localState === 'done' && t.localAt && (now - t.localAt) > 3000) {
        t.localState = 'stale';
        if (t.scan === 'dismissed') t.scan = 'plotted';   // give it another look
      }
    });
  }

  /* SCENE MODE - the fast path, and the one that behaves like a live AR
     label: no object detection at all, just one classification of what is in
     the middle of the frame. Measured at ~143ms on software GL, so it stays
     inside the half-second budget on hardware far slower than a phone.

     This is what you want when you are walking around pointing at one plant
     at a time; the detector is for scenes with several things in them. */
  var scenePrev = null, sceneHold = 0;

  function scene(video, cb) {
    if (!net || sceneBusy) return;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    /* Centre square, 70% of the short side: what the camera is aimed at. */
    var side = Math.min(vw, vh) * 0.7;
    var sx = (vw - side) / 2, sy = (vh - side) / 2;
    pctx.drawImage(video, sx, sy, side, side, 0, 0, 224, 224);

    sceneBusy = true;
    var t0 = performance.now();
    net.classify(pad, 3).then(function (preds) {
      sceneBusy = false;
      var ms = performance.now() - t0;
      stats.n++; stats.total += ms; stats.last = ms;
      if (ms > stats.worst) stats.worst = ms;
      considerStepDown();
      fails = 0; lastOk = performance.now();   // it ran; a weak result is still a working engine

      if (!preds || !preds.length) return;
      var top = preds[0];
      var name = tidy(top.className);
      if (top.probability < MIN_SCORE || JUNK.test(name)) {
        /* Hold the previous answer briefly rather than flickering to nothing
           as the camera moves - an empty label that reappears is worse to
           read than a slightly stale one. */
        if (scenePrev && (performance.now() - sceneHold) < 1200) return;
        scenePrev = null;
        cb(null);
        return;
      }
      fails = 0; lastOk = performance.now();
      scenePrev = { name: name, score: top.probability, ms: Math.round(ms),
                    margin: top.probability - (preds[1] ? preds[1].probability : 0),
                    kind: kindOfLabel(name),
                    alt: preds.slice(1).map(function (p) { return tidy(p.className); }) };
      sceneHold = performance.now();
      cb(scenePrev);
    }).catch(function (e) {
      sceneBusy = false;
      lastErr = 'scene: ' + String(e && e.message || e).slice(0, 90);
      fails++;
      demoteAndRetry(e).catch(function () {});
    });
  }
  var sceneBusy = false;

  function sceneLast() { return scenePrev; }

  /* ---- GRID SCAN: plotting targets with NO detector -------------------
     coco-ssd is the only piece still fetched from a third party, and when it
     cannot load nothing gets plotted at all - a chair and a person are both
     classes it knows, so their absence is the tell.
     This sweeps the frame in overlapping regions, classifies ONE per pass
     with the vendored model, and reports the regions that come back
     confident. It needs no detector, no network and no key, so targets
     appear even when everything external is unreachable. Boxes are region
     shaped rather than object shaped - a real trade, and far better than a
     blank screen. */

  var GRID = [];           // [x,y,w,h] in 0..1, built once per aspect
  var gridAt = 0;
  var gridHits = [];       // { box, name, score, at }
  var gridBusy = false;
  var GRID_TTL = 6000;
  var gridLast = {};       // region index -> the answer its previous pass gave
  var GRID_AGREE_MS = 9000;  // how long a previous answer stays comparable

  function buildGrid() {
    if (GRID.length) return;
    var step = 1 / 3, size = 0.42;
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        var cx = step * (c + 0.5), cy = step * (r + 0.5);
        GRID.push([
          Math.max(0, cx - size / 2), Math.max(0, cy - size / 2),
          Math.min(size, 1 - Math.max(0, cx - size / 2)),
          Math.min(size, 1 - Math.max(0, cy - size / 2))
        ]);
      }
    }
  }

  /* One region per call: a full sweep costs nine classifications, so doing
     them all in a frame would stall the interface. */
  function gridStep(video) {
    if (!net || gridBusy) return;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    buildGrid();

    var g = GRID[gridAt % GRID.length];
    var idx = gridAt % GRID.length;
    gridAt++;

    var box = [g[0] * vw, g[1] * vh, g[2] * vw, g[3] * vh];
    pctx.fillStyle = '#000';
    pctx.fillRect(0, 0, 224, 224);
    pctx.drawImage(video, box[0], box[1], box[2], box[3], 0, 0, 224, 224);

    /* IS THERE ANYTHING HERE?

       The grid classifies a square of the scene, and a square of plain
       carpet is still a square: the model dutifully returned "Paper Towel",
       "Lemon" and "Mortarboard" for three patches of the same rug. A
       classifier has no way to answer "nothing" - it always returns its
       best of 1000 - so the question has to be asked before it is called.

       Edge energy answers it cheaply. A crop containing an object has
       structure; a crop of flat fabric, wall or sky does not. */
    if (!hasDetail(pad)) { gridLast[idx] = null; return; }

    gridBusy = true;
    var t0 = performance.now();
    net.classify(pad, 2).then(function (preds) {
      gridBusy = false;
      var ms = performance.now() - t0;
      stats.n++; stats.total += ms; stats.last = ms;
      considerStepDown();

      fails = 0; lastOk = performance.now();
      var now = performance.now();
      gridHits = gridHits.filter(function (h) { return (now - h.at) < GRID_TTL && h.idx !== idx; });

      if (!preds || !preds.length) return;
      var top = preds[0];
      var name = tidy(top.className);
      if (top.probability < MIN_SCORE || JUNK.test(name)) return;

      /* AGREEMENT. A grid region is an arbitrary square of the scene, so a
         single pass over it is a guess about a crop, not about an object.
         A tree outside a window came back "rapeseed", then "pot", then
         "valley" - three passes, three unrelated answers, all shown.

         So a region has to give the SAME answer twice in a row before it
         counts. A guess that cannot repeat itself is exactly the guess that
         should not be on screen. */
      var prev = gridLast[idx];
      gridLast[idx] = { name: name, at: now };
      if (!prev || prev.name !== name || (now - prev.at) > GRID_AGREE_MS) return;

      gridHits.push({ idx: idx, box: box, name: name, score: top.probability,
                      kind: kindOfLabel(name), at: now });
    }).catch(function (e) {
      gridBusy = false;
      lastErr = 'grid: ' + String(e && e.message || e).slice(0, 90);
      fails++;
      demoteAndRetry(e).catch(function () {});
    });
  }

  /* The nine regions overlap on purpose, so one large subject is inside
     several of them. Returning all of those as separate targets is how one
     tree became three cards. Strongest first, and anything overlapping a
     region already returned is dropped. */
  /* Mean absolute gradient over a subsample of the crop, 0..255. Measured
     on the owner's own photographs: plain carpet and bare wall sit under 6,
     a backpack or a cluttered table is 15 and up. The bar is deliberately
     low - this is meant to reject the obviously empty, not to judge. */
  var DETAIL_MIN = 8;
  function hasDetail(canvas) {
    try {
      var g = canvas.getContext('2d');
      var d = g.getImageData(0, 0, 224, 224).data;
      var sum = 0, n = 0;
      // every 4th pixel in each direction is plenty and costs a sixteenth
      for (var y = 4; y < 220; y += 4) {
        for (var x = 4; x < 220; x += 4) {
          var i = (y * 224 + x) * 4;
          var here = d[i] + d[i + 1] + d[i + 2];
          var right = d[i + 16] + d[i + 17] + d[i + 18];
          var down = d[i + 224 * 16] + d[i + 224 * 16 + 1] + d[i + 224 * 16 + 2];
          sum += (Math.abs(here - right) + Math.abs(here - down)) / 3;
          n += 2;
        }
      }
      return n ? (sum / n) >= DETAIL_MIN : true;
    } catch (e) {
      return true;      // unreadable canvas must not silently stop the scan
    }
  }

  function gridTargets() {
    var now = performance.now();
    gridHits = gridHits.filter(function (h) { return (now - h.at) < GRID_TTL; });
    return suppress(gridHits);
  }

  function suppress(list) {
    var sorted = list.slice().sort(function (a, b) { return b.score - a.score; });
    var keep = [];
    sorted.forEach(function (h) {
      for (var i = 0; i < keep.length; i++) {
        var k = keep[i];
        var ax = Math.max(h.box[0], k.box[0]), ay = Math.max(h.box[1], k.box[1]);
        var bx = Math.min(h.box[0] + h.box[2], k.box[0] + k.box[2]);
        var by = Math.min(h.box[1] + h.box[3], k.box[1] + k.box[3]);
        var inter = Math.max(0, bx - ax) * Math.max(0, by - ay);
        if (!inter) continue;
        var small = Math.min(h.box[2] * h.box[3], k.box[2] * k.box[3]);
        if (inter / small > 0.35) return;        // same part of the scene
      }
      keep.push(h);
    });
    return keep;
  }

  /* One place the UI can ask "what is actually going on", so a failure is
     never rendered as an empty screen. */
  function state() {
    /* A retry after a failure must not be reported as a first load. Showing
       "LOADING… FIRST RUN DOWNLOADS 6MB" while something is actually failing
       over and over is a hopeful message covering a real fault. */
    if (!net && (tries > 1 || exhausted) && lastErr) {
      return { code: exhausted ? 'failed' : 'retrying', detail: lastErr, attempt: tries };
    }
    if (net) {
      /* A recent success outranks any earlier failures. Without this an
         engine that stumbled once while the video was warming up reported
         "erroring" for the rest of the session. */
      var recentlyOk = lastOk && (performance.now() - lastOk) < 5000;
      var bad = fails > 3 && !recentlyOk;
      return { code: bad ? 'erroring' : 'ready', detail: bad ? lastErr : '' };
    }
    if (loading) return { code: 'loading', detail: '' };
    return { code: 'failed',
             detail: lastErr || (trace.length ? 'load ran but recorded nothing - ' + trace[trace.length - 1]
                                              : 'load() was never called') };
  }

  function timing() {
    return {
      backend: backend,
      model: variant + (variant.indexOf('local') !== -1 ? ' a0.5' : ' a' + alpha),
      last: Math.round(stats.last),
      mean: stats.n ? Math.round(stats.total / stats.n) : 0,
      worst: Math.round(stats.worst),
      n: stats.n
    };
  }

  function setBudget(n) { perFrame = U.clamp(n | 0, 1, 8); }

  /* SELF-STARTING, and retrying.

     "load() was never called" was a real report. Whatever stopped the call -
     an exception earlier in boot, a path that returned first - the recogniser
     should not depend on another module remembering to start it. It now
     starts as soon as its own script has run, and retries with backoff if it
     fails, so a single transient error is not permanent. Explicit calls from
     boot() and start() are harmless: load() returns the in-flight promise. */
  function kick(attempt) {
    attempt = attempt || 1;
    tries = attempt;
    var p;
    try { p = load(); }
    catch (e) {
      lastErr = 'kick threw: ' + String(e && e.message || e).slice(0, 100);
      mark('kick threw');
      return;
    }
    p.then(function (m) {
      if (m) { tries = 0; return; }
      if (attempt >= 4) { exhausted = true; return; }
      var wait = attempt * 2500;
      mark('retry ' + attempt + ' in ' + wait + 'ms');
      setTimeout(function () { kick(attempt + 1); }, wait);
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { kick(1); });
    } else {
      setTimeout(function () { kick(1); }, 0);
    }
  }

  return { load: load, ready: ready, lastError: lastError, state: state, ensureTf: ensureTf, ok: function(){ return lastOk; },
           trace: function () { return trace.slice(); }, label: label, sweep: sweep, age: age,
           scene: scene, sceneLast: sceneLast, kindOfLabel: kindOfLabel,
           gridStep: gridStep, gridTargets: gridTargets,
           timing: timing, tidy: tidy, backendName: backendName, setBudget: setBudget,
           /* Test seam: seeds the grid's own store so a suite drives the
              REAL gridTargets() door. Asserting against suppress() directly
              would stay green if nothing ever called it. */
           _testDetail: hasDetail,
           _testGridSeed: function (h) { gridHits = h.slice(); },
           _testGridTargets: gridTargets,
           /* Installs a stand-in classifier so a suite can run the REAL
              gridStep and watch what it chooses to believe. */
           _testSetNet: function (classify) {
             net = { classify: classify };
             gridBusy = false; gridAt = 0; gridHits = []; gridLast = {};
           } };
})();
