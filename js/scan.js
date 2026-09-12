/* Sightline - reading the codes in the frame.

   Two engines, and the good one costs nothing. Chrome on Android has
   BarcodeDetector built in: no download, no wasm, and it is fast. Where it
   is missing - Safari, most desktops - the same API is filled in by ZXing
   compiled to WebAssembly, fetched the first time a scan is asked for and
   not before. A megabyte is not part of the boot for a feature you may
   never use.

   What is scanned is a downscaled copy of the frame, a few times a second.
   A code is reported once and then held quiet, because a barcode sitting in
   view is ONE thing you scanned, not thirty.                              */
'use strict';

var SCAN = (function () {

  /* Everything worth having on a shelf or a poster. Anything not listed is
     not looked for, because each extra format is more work per frame. */
  var FORMATS = [
    'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e',
    'code_128', 'code_39', 'itf', 'data_matrix', 'aztec', 'pdf417'
  ];

  var detector = null;
  var starting = null;
  var err = '';
  var native = false;
  var pad = null, pctx = null;

  var seen = {};            // value -> when it was last reported
  var QUIET_MS = 6000;      // how long one code stays "already scanned"
  var last = null;          // the most recent hit, for the UI
  var listeners = [];
  var busy = false, lastRun = 0;
  var EVERY_MS = 420;

  function on(fn) { listeners.push(fn); }
  function emit(hit) { listeners.forEach(function (f) { try { f(hit); } catch (e) {} }); }

  function supported() { return !!detector; }
  function usingNative() { return native; }
  function error() { return err; }
  function latest() { return last; }

  /* Load the ponyfill and point it at the wasm we ship. Without the
     override it asks jsdelivr, and a device that cannot reach a CDN gets no
     scanner at all - the same trap the models were in. */
  function loadPonyfill() {
    return new Promise(function (res) {
      var sc = document.createElement('script');
      sc.src = 'vendor/barcode-detector.js';
      sc.async = true;
      sc.onload = function () {
        var api = window.BarcodeDetectionAPI;
        if (!api || !api.BarcodeDetector) { err = 'the scanner loaded but is incomplete'; return res(false); }
        try {
          api.setZXingModuleOverrides({
            locateFile: function (file, prefix) {
              return /\.wasm$/.test(file) ? 'vendor/zxing_reader.wasm' : prefix + file;
            }
          });
        } catch (e) { /* an older build without overrides still works from its default */ }
        try { detector = new api.BarcodeDetector({ formats: FORMATS }); }
        catch (e) { err = String(e && e.message || e).slice(0, 90); return res(false); }
        res(true);
      };
      sc.onerror = function () { err = 'the scanner could not be fetched'; res(false); };
      document.head.appendChild(sc);
    });
  }

  function start() {
    if (detector) return Promise.resolve(true);
    if (starting) return starting;
    starting = Promise.resolve().then(function () {
      if (window.BarcodeDetector) {
        try {
          detector = new window.BarcodeDetector({ formats: FORMATS });
          native = true;
          return true;
        } catch (e) { /* the browser has it but not these formats */ }
      }
      return loadPonyfill();
    }).catch(function (e) {
      err = String(e && e.message || e).slice(0, 90);
      return false;
    });
    return starting;
  }

  function stop() { seen = {}; last = null; }

  function canvas(w, h) {
    if (!pad) {
      pad = document.createElement('canvas');
      pctx = pad.getContext('2d', { willReadFrequently: true });
    }
    if (pad.width !== w || pad.height !== h) { pad.width = w; pad.height = h; }
    return pad;
  }

  /* One pass over the current frame. Safe to call every animation frame:
     it paces itself and does nothing while a pass is outstanding. */
  function step(video) {
    if (!detector || busy || !video || !video.videoWidth) return;
    var now = performance.now();
    if (now - lastRun < EVERY_MS) return;
    lastRun = now;

    /* A barcode needs resolution to read, but not the full frame - 720px on
       the long side is plenty and a quarter of the work. */
    var vw = video.videoWidth, vh = video.videoHeight;
    var scale = Math.min(1, 720 / Math.max(vw, vh));
    var w = Math.round(vw * scale), h = Math.round(vh * scale);
    var c = canvas(w, h);
    try { pctx.drawImage(video, 0, 0, w, h); }
    catch (e) { return; }

    busy = true;
    detector.detect(c).then(function (codes) {
      busy = false;
      if (!codes || !codes.length) return;
      var t = Date.now();
      codes.forEach(function (code) {
        var value = String(code.rawValue || '').trim();
        if (!value) return;
        if (seen[value] && (t - seen[value]) < QUIET_MS) { seen[value] = t; return; }
        seen[value] = t;
        var b = code.boundingBox || {};
        last = {
          value: value,
          format: String(code.format || '').replace(/_/g, ' '),
          /* Back to video pixels, so the caller can box it like anything
             else the camera found. */
          box: [ (b.x || 0) / scale, (b.y || 0) / scale,
                 (b.width || 0) / scale, (b.height || 0) / scale ],
          at: t
        };
        emit(last);
      });
      /* Forget codes nobody has seen for a while, so the table cannot grow
         without bound over a long session. */
      Object.keys(seen).forEach(function (k) { if (t - seen[k] > 60000) delete seen[k]; });
    }).catch(function (e) {
      busy = false;
      err = 'scan: ' + String(e && e.message || e).slice(0, 70);
    });
  }

  function state() {
    return { ready: !!detector, native: native, error: err,
             formats: FORMATS.length, held: Object.keys(seen).length };
  }

  return { start: start, stop: stop, step: step, on: on, state: state,
           supported: supported, usingNative: usingNative, error: error,
           latest: latest, FORMATS: FORMATS };
})();
