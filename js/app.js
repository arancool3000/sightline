/* Sightline - boot and the main loop. */
'use strict';

(function () {

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
      .then(function (m) { model = m; return m; })
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

    if (model && now - lastDetect >= DETECT_MS) {
      lastDetect = now;
      detectOnce(now);
    }

    UI.draw(TRACK.all());
  }

  var detecting = false;
  function detectOnce(now) {
    if (detecting) return;
    detecting = true;

    model.detect(U.$('#cam'), 12, 0.5).then(function (preds) {
      detecting = false;

      /* Frames-per-second of the DETECTOR, which is what actually costs
         anything - the overlay itself redraws every animation frame. */
      frameTimes.push(performance.now());
      while (frameTimes.length > 20) frameTimes.shift();
      if (frameTimes.length > 4) {
        var span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
        var v = U.$('#fps');
        var txt = span > 0 ? Math.round((frameTimes.length - 1) / span) + ' fps' : '--';
        if (v.textContent !== txt) v.textContent = txt;
      }

      var dets = preds
        .filter(function (p) { return allowed(p.class); })
        .map(function (p) { return { cls: p.class, box: p.bbox.slice(), score: p.score }; });

      var tracks = TRACK.update(dets, now);

      /* Spend a lookup only on things that have settled. */
      if (SET.hasApi()) {
        for (var i = 0; i < tracks.length; i++) {
          var t = tracks[i];
          if (t.state === 'new' && TRACK.stable(t, now, 600)) { IDENT.forTrack(t); break; }
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
