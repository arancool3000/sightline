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
        /* Boxes are gone, live labelling is not. Say exactly that rather than
           implying the app is broken. */
        U.toast('Multi-object boxes unavailable. Live labelling is working.', 4500);
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

    UI.draw(TRACK.all());
  }

  var sceneRec = null, sceneFirstAt = 0, detectCost = 0;

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
  function needsCloud(t) {
    var kind = IDENT.kindOf(t.cls);
    if (kind === 'person') return SET.get('faces');      // no on-device model knows who anyone is
    if (kind === 'vehicle') return true;                 // make/model/generation is not in ImageNet
    if (kind === 'plant') return true;                   // species precision needs a specialist
    if (!t.local) return true;                           // the device had no confident answer
    return t.local.score < 0.55;                         // weak local guess: ask for a better one
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

  /* Offline shell. Registration failing is not an error worth surfacing -
     the app works exactly the same without it. */
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
