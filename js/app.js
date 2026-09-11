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
    U.$$('.dockbtn[data-mode]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.mode === SET.get('mode') ? 'true' : 'false');
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

  function loadModel() {
    if (model || !window.cocoSsd) return Promise.resolve(null);
    return cocoSsd.load({ base: 'lite_mobilenet_v2' })
      .then(function (m) {
        model = m;
        /* The fine-grained classifier loads in parallel. Detection works
           without it; labels are just coarser until it arrives. */
        LOCAL.load();
        return m;
      })
      .catch(function () {
        U.toast('Could not load the local detector - tap anywhere to identify instead');
        return null;
      });
  }

  function start() {
    var btn = U.$('#btnStart');
    btn.disabled = true;
    btn.textContent = 'Starting…';

    CAM.start(SET.get('facing'))
      .then(function () { return loadModel(); })
      .then(function () {
        U.$('#gate').classList.add('hidden');
        UI.resize();
        running = true;
        loop();
        if (!SET.hasApi()) {
          setTimeout(function () {
            U.toast('Add your analysis endpoint in Settings to name what you see', 4200);
          }, 1200);
        }
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
        var v = U.$('#fps');
        var txt = span > 0 ? Math.round((frameTimes.length - 1) / span) + ' fps' : '--';
        if (v.textContent !== txt) v.textContent = txt;

        var rep = latencyReport();
        var l = U.$('#lat');
        var ltxt = rep ? (rep.median + 'ms') : '--';
        if (l.textContent !== ltxt) {
          l.textContent = ltxt;
          l.style.color = rep && rep.median > 500 ? '#ffcf5d' : '';
        }
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
