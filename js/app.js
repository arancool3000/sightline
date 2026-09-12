/* Sightline - boot and the main loop. */
'use strict';

(function () {

  var bootAt = performance.now();
  var model = null;
  var running = false;
  var lastDetect = 0;
  var DETECT_MS = 90;              // ~11 detector passes a second; boxes are smoothed between
  var frameTimes = [];
  var loopHandle = null;

  var MODE_KINDS = {
    all: null,                                   // null means everything
    objects: { object: 1 },
    nature: { animal: 1, plant: 1, insect: 1 },
    vehicles: { vehicle: 1 },
    people: { person: 1 }
  };

  function allowed(cls) {
    var want = MODE_KINDS[SET.get('mode')];
    if (!want) return true;
    return !!want[IDENT.kindOf(cls)];
  }

  function boot() {
    UI.init();
    CAM.attach(U.$('#cam'));

    /* Restore the last-used dock mode. */
    U.$$('.mbtn[data-mode]').forEach(function (b) {
      var on = b.dataset.mode === SET.get('mode');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) UI.tele('#tMode', b.textContent.trim());
    });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      U.$('#gateNote').textContent = 'This browser cannot open a camera. Try Chrome, Edge or Safari over https.';
      U.$('#btnStart').disabled = true;
      return;
    }
    if (!window.isSecureContext) {
      U.$('#gateNote').textContent = 'A camera needs a secure connection. Open this page over https.';
    }

    U.$('#btnStart').addEventListener('click', start);

    /* Warm the model while the user reads the start screen - by the time they
       tap, detection is usually ready instantly. */
    loadModel();
  }

  /* The two models are INDEPENDENT and must load that way.
     They did not: LOCAL.load() used to sit inside the detector's .then(), so a
     single failed detector fetch also stopped the classifier - and the
     classifier is the realtime path the whole app rests on. One bad request
     took out everything instead of just the boxes. */
  var detectorErr = '';

  function loadModel() {
    var jobs = [];

    if (!model && window.cocoSsd) {
      jobs.push(
        cocoSsd.load({ base: 'lite_mobilenet_v2' })
          .then(function (m) { model = m; detectorErr = ''; })
          .catch(function (e) {
            detectorErr = String(e && e.message || e).slice(0, 120);
            model = null;                       // the app keeps working without it
          })
      );
    }

    /* Started here, not after the detector resolves. */
    jobs.push(LOCAL.load());

    return Promise.all(jobs).then(function () {
      var haveScene = LOCAL.ready();
      if (!haveScene) {
        U.toast('Could not load the recogniser. ' + (LOCAL.lastError() || detectorErr || 'Check your connection.') + ' Tap CFG to retry.', 7000);
      } else if (!model) {
        /* Boxes from the detector are gone; the grid sweep replaces them. Say
           so on screen - the console is no use on a phone. */
        U.toast('Detector unavailable - scanning the frame directly instead.', 4500);
        UI.tele('#tEng', 'GRID');
      }
      UI.tele('#tGpu', (LOCAL.timing().backend || '--').toUpperCase());
      return model;
    });
  }

  window.SL_RELOAD = function () { model = null; return loadModel(); };
  window.SL_DIAG = function () {
    return {
      detector: model ? 'ok' : ('failed: ' + (detectorErr || 'not attempted')),
      classifier: LOCAL.ready() ? 'ok' : ('failed: ' + (LOCAL.lastError() || 'not attempted')),
      libs: { tf: !!window.tf, cocoSsd: !!window.cocoSsd, mobilenet: !!window.mobilenet },
      backend: LOCAL.timing().backend,
      secure: window.isSecureContext
    };
  };

  function start() {
    var btn = U.$('#btnStart');
    btn.disabled = true;
    btn.textContent = 'Starting…';

    CAM.start(SET.get('facing'))
      .then(function () {
        /* Show the camera the INSTANT it is live. The models are tens of
           megabytes on a first run and waiting for them here left the user
           staring at the start screen with no feedback; labels simply appear
           once the weights arrive. */
        U.$('#gate').classList.add('hidden');
        UI.resize();
        running = true;
        UI.tele('#tEng', SET.hasApi() ? 'CLOUD' : 'LOCAL');
        UI.tele('#tGpu', 'LOAD');
        loop();
        loadModel();                    // deliberately not awaited
      })
      .catch(function (e) {
        btn.disabled = false;
        btn.textContent = 'Start camera';
        var name = String(e && e.name || '');
        U.$('#gateNote').textContent =
          name === 'NotAllowedError' ? 'Camera permission was refused. Allow it in your browser settings and try again.'
          : name === 'NotFoundError' ? 'No camera was found on this device.'
          : 'Could not start the camera: ' + (e && e.message ? e.message : 'unknown error');
      });
  }

  function loop() {
    if (!running) return;
    loopHandle = requestAnimationFrame(loop);

    if (!CAM.live()) return;
    var now = performance.now();

    /* PRIORITY: the scene label is the realtime promise, so it runs first and
       always. The detector is the expensive half (measured 555-631ms on
       software GL), so it only runs when there is headroom left over - on a
       slow device it thins out rather than starving the live label. */
    if (LOCAL.ready()) {
      LOCAL.scene(U.$('#cam'), function (r) {
        sceneRec = r;
        if (r && !sceneFirstAt) sceneFirstAt = performance.now();
        UI.sceneLabel(r);
      });
    }

    if (model && now - lastDetect >= detectEvery()) {
      lastDetect = now;
      detectOnce(now);
    }

    /* No detector, no targets - which is exactly what happened: a chair and a
       person are both classes it knows, so nothing plotting at all was the
       tell that it never loaded. Sweep the frame ourselves instead, using the
       model that IS available locally. */
    if (!model && LOCAL.ready() && now - lastGrid >= 260) {
      lastGrid = now;
      LOCAL.gridStep(U.$('#cam'));
      gridToTracks(now);
    }

    UI.draw(TRACK.all());
  }

  /* Ring of recent time-to-label measurements. Its declaration was lost in an
     earlier edit while eight call sites kept using it - under strict mode
     that throws a ReferenceError on every grid pass, which is the primary
     path when the detector is unavailable. */
  var latency = [];
  var sceneRec = null, sceneFirstAt = 0, detectCost = 0, lastGrid = 0;

  /* Turn confident grid regions into tracks so they render, are tappable and
     carry a verdict exactly like detector targets do. */
  function gridToTracks(now) {
    var hits = LOCAL.gridTargets();
    var dets = hits.map(function (hh) {
      return { cls: hh.kind === 'object' ? 'grid' : hh.kind, box: hh.box.slice(), score: hh.score };
    });
    var tracks = TRACK.update(dets, now);
    tracks.forEach(function (t) {
      var hit = null, best = 0;
      hits.forEach(function (hh) {
        var o = U.iou(t.box, hh.box);
        if (o > best) { best = o; hit = hh; }
      });
      if (!hit || best < 0.3) return;
      t.label = hit.name;
      t.tier = 'local';
      t.scan = 'relevant';
      t.localState = 'done';
      t.local = { name: hit.name, score: hit.score, ms: 0, alt: [] };
      if (!t.labelMs) {
        t.labelMs = Math.round(performance.now() - t.born);
        latency.push(t.labelMs);
        while (latency.length > 30) latency.shift();
      }
    });
  }

  /* How often the detector may run. Derived from what it actually costs on
     this device, never a fixed number: a phone that needs 600ms a pass must
     not be asked for one every 90ms, or the scene label never gets the GPU. */
  function detectEvery() {
    if (!detectCost) return DETECT_MS;
    return U.clamp(detectCost * 1.6, DETECT_MS, 2000);
  }

  /* Does this track still need a server? Only when the device cannot know the
     answer, or was not confident. Everything else stays purely local, which
     keeps the free allowance for the things that actually need it. */
  /* What counts as identified changed: a generic noun is not an answer.
     "Chair", "printer", "laptop" tell the viewer nothing they cannot already
     see, and the on-device model can produce nothing better - so a CONFIDENT
     local label is exactly as much a reason to ask for detail as a weak one
     was. Previously a confident local guess skipped the cloud entirely,
     which is why nothing ever gained a model name or a price. */
  function needsCloud(t) {
    if (IDENT.kindOf(t.cls) === 'person') return SET.get('faces');
    return true;
  }

  function latencyReport() {
    if (!latency.length) return null;
    var s = latency.slice().sort(function (a, b) { return a - b; });
    return {
      median: s[Math.floor(s.length / 2)],
      p90: s[Math.floor(s.length * 0.9)],
      worst: s[s.length - 1],
      n: s.length
    };
  }
  /* Everything the half-second claim rests on, readable from the console on
     the actual device: window.SL_PERF() */
  window.SL_LATENCY = latencyReport;
  window.SL_PERF = function () {
    var l = latencyReport();
    return {
      sceneLabelMs: LOCAL.sceneLast() ? LOCAL.sceneLast().ms : null,
      firstSceneLabelMs: sceneFirstAt ? Math.round(sceneFirstAt - bootAt) : null,
      detectorMs: Math.round(detectCost),
      detectorEveryMs: Math.round(detectEvery()),
      perObject: l,
      classifier: LOCAL.timing()
    };
  };

  var detecting = false;
  function detectOnce(now) {
    if (detecting) return;
    detecting = true;

    var dt0 = performance.now();
    model.detect(U.$('#cam'), 12, 0.5).then(function (preds) {
      detecting = false;
      var cost = performance.now() - dt0;
      detectCost = detectCost ? (detectCost * 0.7 + cost * 0.3) : cost;

      /* Frames-per-second of the DETECTOR, which is what actually costs
         anything - the overlay itself redraws every animation frame. */
      frameTimes.push(performance.now());
      while (frameTimes.length > 20) frameTimes.shift();
      if (frameTimes.length > 4) {
        var span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
        UI.tele('#tFps', span > 0 ? String(Math.round((frameTimes.length - 1) / span)) : '--');

        var rep = latencyReport();
        UI.tele('#tLat', rep ? rep.median + 'ms' : '--');

        var ti = LOCAL.timing();
        UI.tele('#tGpu', (ti.backend || '--').toUpperCase());
      }

      var dets = preds
        .filter(function (p) { return allowed(p.class); })
        .map(function (p) { return { cls: p.class, box: p.bbox.slice(), score: p.score }; });

      var tracks = TRACK.update(dets, now);

      /* TIER 1 - on device, right now. No waiting for stability and no
         network, because this is the tier that has to beat half a second.
         A track created this pass is classified this pass. */
      LOCAL.age(tracks, now);
      LOCAL.sweep(U.$('#cam'), tracks);

      /* Record how long each object actually took to get a real label.
         The half-second target is a measurement, not a claim. */
      tracks.forEach(function (t) {
        if (!t.labelMs && t.label) {
          t.labelMs = Math.round(performance.now() - t.born);
          latency.push(t.labelMs);
          while (latency.length > 30) latency.shift();
        }
      });

      /* TIER 2 - the cloud, in the background, only for what the device
         genuinely cannot know: who someone is, which exact model of car,
         which species when the on-device guess was too weak to show. */
      if (SET.hasApi()) {
        for (var i = 0; i < tracks.length; i++) {
          var t = tracks[i];
          if (t.state !== 'new' || !TRACK.stable(t, now, 500)) continue;
          if (!needsCloud(t)) { t.state = 'skipped'; t.reason = 'local-was-enough'; continue; }
          IDENT.forTrack(t);
          break;
        }
      }
      UI.refreshOpen();
    }).catch(function () {
      detecting = false;    // a detector hiccup must not stop the loop
    });
  }

  /* Free the camera when the page is backgrounded - a hot lens and a drained
     battery are the fastest way to lose a user. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      running = false;
      if (loopHandle) cancelAnimationFrame(loopHandle);
      CAM.stop();
      if (CAPS.running()) CAPS.stop();
    } else if (!U.$('#gate').classList.contains('hidden')) {
      /* never started - nothing to resume */
    } else {
      CAM.start(SET.get('facing')).then(function () {
        running = true;
        TRACK.reset();
        UI.resize();
        loop();
      }).catch(function () { U.toast('Camera did not resume - reload the page'); });
    }
  });

  /* Offline shell, and an escape hatch from it.

     A cache-first service worker can strand a device on an old build: it
     serves the stale files before the new worker can take over, so a release
     is invisible until something forces an update. That happened here - a
     deploy sat unseen for an hour. This does three things about it:

       1. asks for an update on every load,
       2. when a new worker takes control, reloads ONCE so the fresh files
          are actually the ones running,
       3. leaves window.SL_RESET() as a manual clear of last resort.

     The reload is guarded by a session flag so it can never loop. */
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        reg.update();
        setInterval(function () { reg.update(); }, 60 * 60 * 1000);
      }).catch(function () { /* the app works the same without it */ });
    });

    /* controllerchange fires for TWO different things: a worker taking
       control for the first time (a first visit - nothing stale, nothing to
       refresh) and a NEW worker replacing an old one (the case this exists
       for). Reloading on the first would refresh every new visitor for no
       reason, so the presence of an existing controller is the test. */
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) return;
      var once = 'sl_swreload';
      try {
        if (sessionStorage.getItem(once)) return;
        sessionStorage.setItem(once, '1');
      } catch (e) { return; }          // no storage, no reload: never risk a loop
      location.reload();
    });
  }

  /* Clears every cache and worker, then reloads. For when a device is stuck
     on a build that should no longer exist. */
  window.SL_RESET = function () {
    var jobs = [];
    if (window.caches) jobs.push(caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { return caches.delete(k); }));
    }));
    if (navigator.serviceWorker) jobs.push(
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        return Promise.all(rs.map(function (r) { return r.unregister(); }));
      })
    );
    return Promise.all(jobs).then(function () {
      try { sessionStorage.clear(); } catch (e) { /* ignore */ }
      location.reload(true);
    });
  };

  /* An uncaught error used to leave a live camera and no explanation. */
  window.addEventListener('error', function (ev) {
    if (window.UI && UI.status) {
      UI.status('ERROR — ' + String((ev && ev.message) || 'unknown').slice(0, 110), 'bad');
    }
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    if (window.UI && UI.status) {
      UI.status('ERROR — ' + String((r && r.message) || r || 'unknown').slice(0, 110), 'bad');
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
