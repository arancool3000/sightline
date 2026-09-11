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

  var net = null, loading = null, backend = '', variant = 'v2';
  var pad = document.createElement('canvas');
  pad.width = pad.height = 224;
  var pctx = pad.getContext('2d', { willReadFrequently: true });

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

  function pickBackend() {
    if (!window.tf) return Promise.resolve('');
    var order = [];
    if (tf.findBackend && tf.findBackend('webgpu')) order.push('webgpu');
    order.push('webgl', 'cpu');

    function tryNext(i) {
      if (i >= order.length) return Promise.resolve(tf.getBackend());
      return tf.setBackend(order[i])
        .then(function (ok) { return ok === false ? tryNext(i + 1) : tf.ready().then(function () { return order[i]; }); })
        .catch(function () { return tryNext(i + 1); });
    }
    return tryNext(0).then(function (b) { backend = b || (tf.getBackend && tf.getBackend()) || ''; return backend; });
  }

  function load() {
    if (net) return Promise.resolve(net);
    if (loading) return loading;
    if (!window.mobilenet) return Promise.resolve(null);

    loading = pickBackend()
      .then(function () {
        /* v2 is the better classifier, but it is served from a different host
           to v1 and some networks block it. Falling back to v1 keeps the
           realtime tier working rather than losing it entirely. */
        return mobilenet.load({ version: 2, alpha: alpha })
          .catch(function () {
            variant = 'v1';
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
      .then(function () { return net; })
      .catch(function () { net = null; return null; });

    return loading;
  }

  function ready() { return !!net; }
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
  function label(video, t) {
    if (!net || t.localState === 'busy') return Promise.resolve(null);
    if (!drawCrop(video, t.raw || t.box)) return Promise.resolve(null);

    t.localState = 'busy';
    var t0 = performance.now();

    return net.classify(pad, 3).then(function (preds) {
      var ms = performance.now() - t0;
      stats.n++; stats.total += ms; stats.last = ms;
      if (ms > stats.worst) stats.worst = ms;
      considerStepDown();

      t.localState = 'done';
      t.localAt = performance.now();

      if (!preds || !preds.length) return null;
      var top = preds[0];
      var name = tidy(top.className);

      if (top.probability < MIN_SCORE || JUNK.test(name)) {
        t.local = null;                       // keep the generic COCO word
        return null;
      }

      t.local = {
        name: name,
        score: top.probability,
        ms: ms,
        alt: preds.slice(1).map(function (p) { return tidy(p.className); })
      };
      /* Only the cloud tier may overwrite a label it has already sharpened. */
      if (t.tier !== 'cloud') { t.label = name; t.tier = 'local'; }
      return t.local;
    }).catch(function () {
      t.localState = 'failed';
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
      if (t.localState === 'done' && t.localAt && (now - t.localAt) > 3000) t.localState = 'stale';
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
      scenePrev = { name: name, score: top.probability, ms: Math.round(ms),
                    kind: kindOfLabel(name),
                    alt: preds.slice(1).map(function (p) { return tidy(p.className); }) };
      sceneHold = performance.now();
      cb(scenePrev);
    }).catch(function () { sceneBusy = false; });
  }
  var sceneBusy = false;

  function sceneLast() { return scenePrev; }

  function timing() {
    return {
      backend: backend,
      model: variant + ' a' + alpha,
      last: Math.round(stats.last),
      mean: stats.n ? Math.round(stats.total / stats.n) : 0,
      worst: Math.round(stats.worst),
      n: stats.n
    };
  }

  function setBudget(n) { perFrame = U.clamp(n | 0, 1, 8); }

  return { load: load, ready: ready, label: label, sweep: sweep, age: age,
           scene: scene, sceneLast: sceneLast, kindOfLabel: kindOfLabel,
           timing: timing, tidy: tidy, backendName: backendName, setBudget: setBudget };
})();
