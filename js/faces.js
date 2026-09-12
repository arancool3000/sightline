/* Sightline - remembering a face you have met.

   "add feature where it can remember faces you have met and you can assign
    names to them so if it sees them and you can't remember their name it
    will point to them and show name."

   A memory aid, and built like one.

   ALL OF IT STAYS ON THIS DEVICE. The face never leaves the phone, the
   descriptor never leaves the phone, and there is no server involved at any
   point - not even the app's own. What is stored is 128 numbers that
   describe a face, which cannot be turned back into a picture of anybody.

   IT IS OFF UNTIL SWITCHED ON. Nothing is detected, nothing is computed and
   the models are not even fetched until the owner asks for this. One tap
   forgets a person; one tap forgets everyone.

   This is deliberately NOT the public-figure lookup. That one names people
   who are already famous and refuses everyone else. This one names only
   people YOU have met and told it about, and it tells nobody else.        */
'use strict';

var FACES = (function () {

  var KEY = 'sightline.faces.v1';
  var MODELS = 'vendor/models/faces';

  var lib = null;            // the loading promise
  var ready = false;
  var err = '';
  var people = [];           // [{ id, name, d:[128], met, seen, times }]
  var enabled = false;

  /* face-api's own recommended bar is 0.6 over a research set. This is
     stricter, because the cost of the two mistakes is not equal: failing to
     recognise a friend is a shrug, and putting your friend's name on a
     stranger is the app being wrong about a person to their face. */
  var MATCH = 0.48;
  var EVERY_MS = 900;
  var last = 0, busy = false;

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      people = raw ? (JSON.parse(raw) || []) : [];
    } catch (e) { people = []; }
    try { enabled = localStorage.getItem(KEY + '.on') === '1'; } catch (e) {}
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(people)); } catch (e) {}
  }

  function isOn() { return enabled; }
  function state() {
    return { on: enabled, ready: ready, error: err, known: people.length,
             loading: !!lib && !ready };
  }

  function setOn(v) {
    enabled = !!v;
    try { localStorage.setItem(KEY + '.on', enabled ? '1' : '0'); } catch (e) {}
    if (enabled) start();
    return enabled;
  }

  /* The library and the three models, fetched once, on request. Together
     they are about eight megabytes, which is not something to download on
     the chance somebody might want it. */
  function start() {
    if (lib) return lib;
    lib = new Promise(function (res) {
      var sc = document.createElement('script');
      sc.src = 'vendor/face-api.js';
      sc.async = true;
      sc.onload = function () {
        if (!window.faceapi) { err = 'the face library loaded but is incomplete'; return res(false); }
        var n = faceapi.nets;
        Promise.all([
          n.tinyFaceDetector.loadFromUri(MODELS),
          n.faceLandmark68TinyNet.loadFromUri(MODELS),
          n.faceRecognitionNet.loadFromUri(MODELS)
        ]).then(function () { ready = true; err = ''; res(true); })
          .catch(function (e) { err = String(e && e.message || e).slice(0, 110); res(false); });
      };
      sc.onerror = function () { err = 'the face library could not be fetched'; res(false); };
      document.head.appendChild(sc);
    });
    return lib;
  }

  /* ---- who is this? ---- */

  function distance(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i++) { var d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
  }

  function match(desc) {
    var best = null, bd = Infinity;
    for (var i = 0; i < people.length; i++) {
      var d = distance(desc, people[i].d);
      if (d < bd) { bd = d; best = people[i]; }
    }
    if (!best || bd > MATCH) return null;
    return { person: best, distance: bd,
             /* How near the bar it was, so the card can be quieter about a
                borderline one instead of stating it flatly. */
             sure: bd < MATCH * 0.78 };
  }

  /* One pass. Returns what is in frame: named where known, and offered for
     naming where not. Nothing is stored by looking. */
  function step(video) {
    if (!enabled || !ready || busy || !video || !video.videoWidth) return Promise.resolve(null);
    var now = performance.now();
    if (now - last < EVERY_MS) return Promise.resolve(null);
    last = now;
    busy = true;

    var opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    return faceapi.detectAllFaces(video, opts)
      .withFaceLandmarks(true)
      .withFaceDescriptors()
      .then(function (found) {
        busy = false;
        return (found || []).map(function (f) {
          var d = Array.prototype.slice.call(f.descriptor);
          var m = match(d);
          if (m) {
            m.person.seen = Date.now();
            m.person.times = (m.person.times || 0) + 1;
          }
          var b = f.detection.box;
          return {
            box: [b.x, b.y, b.width, b.height],
            score: f.detection.score,
            descriptor: d,
            name: m ? m.person.name : '',
            id: m ? m.person.id : '',
            met: m ? m.person.met : 0,
            sure: m ? m.sure : false,
            distance: m ? m.distance : 0
          };
        });
      })
      .catch(function (e) {
        busy = false;
        err = 'face pass: ' + String(e && e.message || e).slice(0, 80);
        return null;
      });
  }

  /* ---- the address book ---- */

  function remember(descriptor, name) {
    name = String(name || '').trim().slice(0, 60);
    if (!name || !descriptor || descriptor.length < 100) return null;
    var existing = match(descriptor);
    if (existing) {
      /* Already known: this is a correction, and a second look at the same
         person also makes the memory of them better. */
      existing.person.name = name;
      existing.person.d = blend(existing.person.d, descriptor);
      save();
      return existing.person;
    }
    var p = { id: 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
              name: name, d: descriptor, met: Date.now(), seen: Date.now(), times: 1 };
    people.push(p);
    save();
    return p;
  }

  /* Average the old and new descriptors so a face learned in one light is
     still recognised in another. */
  function blend(a, b) {
    var out = [];
    for (var i = 0; i < a.length; i++) out.push(a[i] * 0.7 + b[i] * 0.3);
    return out;
  }

  function forget(id) {
    var n = people.length;
    people = people.filter(function (p) { return p.id !== id; });
    if (people.length !== n) save();
    return people.length !== n;
  }

  function wipe() { people = []; save(); return true; }
  function all() {
    return people.slice().sort(function (a, b) { return (b.seen || 0) - (a.seen || 0); });
  }
  function rename(id, name) {
    var p = people.filter(function (x) { return x.id === id; })[0];
    if (!p) return false;
    p.name = String(name || '').trim().slice(0, 60);
    save();
    return true;
  }

  load();

  return { step: step, remember: remember, forget: forget, wipe: wipe, all: all,
           rename: rename, state: state, isOn: isOn, setOn: setOn, start: start,
           match: match, distance: distance, MATCH: MATCH };
})();
