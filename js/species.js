/* Sightline - naming the species, on the device.

   This is the part that had no answer for weeks. Every keyless species API
   wants an account, and the general-purpose classifier knows almost no
   species - which is where "rapeseed", "pot" and "valley" for one tree came
   from, and why it was forbidden from guessing at one.

   The answer turned out to be Google's AIY iNaturalist classifiers, mirrored
   in google-coral/test_data under Apache 2.0:

       plants    2,102 species
       insects   1,021 species
       birds       965 species

   They are TFLite, and TFLite runs in a browser over WebAssembly. So this is
   on the device, with no key, no account and no limit - the only kind of
   free that survives being used every day.

   ONE MODEL AT A TIME. Five megabytes of plant names is not fetched because
   you pointed the camera at a bee. The model for a kind is loaded the first
   time that kind is seen and kept after that.

   The labels carry both halves - "Betula lenta (Sweet birch)" - so a result
   is a binomial AND a name a person would use.                             */
'use strict';

var SPECIES = (function () {

  var MODELS = {
    plant:  { file: 'vendor/models/species/plant.tflite',  labels: 'vendor/models/species/plant-labels.json' },
    insect: { file: 'vendor/models/species/insect.tflite', labels: 'vendor/models/species/insect-labels.json' },
    bird:   { file: 'vendor/models/species/bird.tflite',   labels: 'vendor/models/species/bird-labels.json' }
  };

  var loaded = {};       // kind -> { model, labels }
  var loading = {};      // kind -> Promise
  var failed = {};       // kind -> why
  var pathsSet = false;
  var pad = null, pctx = null;

  /* The bird model is the closest thing here to an animal classifier, so
     "animal" is routed to it. A dog is not a bird and will come back with a
     low score, which is exactly what the confidence bar is for. */
  function modelFor(kind) {
    if (kind === 'plant') return 'plant';
    if (kind === 'insect') return 'insect';
    if (kind === 'bird' || kind === 'animal') return 'bird';
    return '';
  }

  function available() { return !!(window.tflite && tflite.loadTFLiteModel); }

  function canvas() {
    if (pad) return pad;
    pad = document.createElement('canvas');
    pad.width = 224; pad.height = 224;
    pctx = pad.getContext('2d', { willReadFrequently: true });
    return pad;
  }

  function load(kind) {
    var k = modelFor(kind);
    if (!k) return Promise.resolve(null);
    if (loaded[k]) return Promise.resolve(loaded[k]);
    if (failed[k]) return Promise.resolve(null);
    if (loading[k]) return loading[k];
    if (!available()) { failed[k] = 'the tflite runtime did not load'; return Promise.resolve(null); }

    loading[k] = Promise.all([
      tflite.loadTFLiteModel(MODELS[k].file),
      fetch(MODELS[k].labels).then(function (r) { return r.json(); })
    ]).then(function (r) {
      loaded[k] = { model: r[0], labels: r[1] };
      delete loading[k];
      return loaded[k];
    }).catch(function (e) {
      failed[k] = String(e && e.message || e).slice(0, 100);
      delete loading[k];
      return null;
    });
    return loading[k];
  }

  /* Identify the species in a region of the video.

     box is [x, y, w, h] in VIDEO pixels. Answers null when there is no model
     for this kind, when it has not loaded yet, or when the model is not sure
     enough to be worth saying - never a shrug dressed as an answer. */
  var MIN = 0.30;
  var MARGIN = 0.10;

  function identify(video, box, kind) {
    var k = modelFor(kind);
    if (!k) return Promise.resolve(null);
    var have = loaded[k];
    if (!have) { load(kind); return Promise.resolve(null); }   // ready for the next pass
    if (!video || !video.videoWidth) return Promise.resolve(null);

    var c = canvas();
    try {
      pctx.drawImage(video, box[0], box[1], box[2], box[3], 0, 0, 224, 224);
    } catch (e) { return Promise.resolve(null); }

    var t0 = performance.now();
    return Promise.resolve().then(function () {
      /* The model is quantised: it wants bytes, not floats. */
      var x = tf.tidy(function () {
        return tf.browser.fromPixels(c).expandDims(0);
      });
      var out;
      try { out = have.model.predict(x); }
      finally { x.dispose(); }

      var scores = out.dataSync ? out.dataSync() : out;
      if (out.dispose) out.dispose();

      var bi = 0, b = -1, si = -1, sv = -1;
      for (var i = 0; i < scores.length; i++) {
        if (scores[i] > b) { sv = b; si = bi; b = scores[i]; bi = i; }
        else if (scores[i] > sv) { sv = scores[i]; si = i; }
      }
      /* Quantised output arrives as 0..255 on some builds and 0..1 on
         others; normalise before judging it. */
      var scale = b > 1.5 ? 255 : 1;
      var top = b / scale, second = Math.max(0, sv) / scale;

      var row = have.labels[bi] || ['', ''];
      /* These models carry a "background" class - it is the LAST one, not
         the first, which a guard written against index 0 sails straight
         past. Reject it by name, which cannot be wrong about where it is. */
      if (!row[0] || /^background$/i.test(row[0])) return null;
      if (top < MIN) return null;

      return {
        scientific: row[0],
        name: row[1] || row[0],
        score: top,
        margin: top - second,
        sure: (top - second) >= MARGIN,
        alt: (function () {
          var r2 = si >= 0 ? have.labels[si] : null;
          if (!r2 || /^background$/i.test(r2[0] || '')) return [];
          return [r2[1] || r2[0]];
        })(),
        ms: Math.round(performance.now() - t0),
        source: 'on-device species'
      };
    }).catch(function (e) {
      failed[k] = 'inference: ' + String(e && e.message || e).slice(0, 80);
      return null;
    });
  }

  function state() {
    return {
      available: available(),
      loaded: Object.keys(loaded),
      loading: Object.keys(loading),
      failed: failed,
      counts: { plant: 2102, insect: 1021, bird: 965 }
    };
  }

  /* The runtime probes for SIMD support while its own script is being
     evaluated - before any of this file runs - so there is no moment at
     which setWasmPath could be called early enough. Its files therefore sit
     where it looks by default, beside the library, and the path is set as
     well for the loads that do respect it. */
  (function () {
    if (!available()) return;
    try { tflite.setWasmPath('vendor/'); pathsSet = true; } catch (e) {}
  })();

  return { load: load, identify: identify, state: state, modelFor: modelFor,
           available: available };
})();
