/* Sightline - fine-grained identification.

   The local detector answers "there is a dog there". This module answers
   "that is a Border Collie", "that is Quercus robur", "that is a 1998 Impreza",
   "that is Ada Lovelace" - by sending ONE small crop to the worker and then
   enriching the answer from Wikipedia/Wikidata.

   Two entry points:
     forTrack(t)   - something the local detector already boxed
     atPoint(x,y)  - anywhere the user tapped. This is the one that covers
                     insects, trees and wild flowers, because COCO-SSD has no
                     class for any of them. */
'use strict';

var IDENT = (function () {

  /* COCO-SSD class -> what we ask the model to do with it. */
  var ROUTE = {
    person: 'person',
    bird: 'animal', cat: 'animal', dog: 'animal', horse: 'animal', sheep: 'animal',
    cow: 'animal', elephant: 'animal', bear: 'animal', zebra: 'animal', giraffe: 'animal',
    'potted plant': 'plant',
    car: 'vehicle', truck: 'vehicle', bus: 'vehicle', motorcycle: 'vehicle',
    bicycle: 'vehicle', airplane: 'vehicle', train: 'vehicle', boat: 'vehicle'
  };

  var KICKER = {
    person: 'Person', animal: 'Animal', plant: 'Plant',
    insect: 'Insect', vehicle: 'Vehicle', object: 'Object'
  };

  var queue = [];
  var inFlight = 0;
  var MAX_FLIGHT = 1;
  var lastSent = 0;
  var quotaBlockedUntil = 0;

  /* WHETHER THE CLOUD IS ACTUALLY ANSWERING.

     A failure here used to land in t.reason and stop. On screen that looked
     exactly like a slow answer: the label kept the on-device noun with a
     trailing mark, for ever. The owner's HUD read ENG CLOUD while nothing
     had ever come back, which is how a 3D printer stayed a Polaroid camera.

     So the outcome of every call is counted, and the telemetry says which
     tier is really doing the work. */
  var health = { sent: 0, ok: 0, failed: 0, lastError: '', lastAt: 0 };
  function healthOf() { return health; }

  /* Grid targets carry their kind as the class directly, since there is no
     detector vocabulary behind them. */
  var KINDS = { person:1, animal:1, plant:1, insect:1, vehicle:1, object:1 };
  function kindOf(cls) {
    if (ROUTE[cls]) return ROUTE[cls];
    if (KINDS[cls]) return cls;
    return 'object';
  }

  function busy() { return inFlight > 0 || queue.length > 0; }

  /* ---- queueing ------------------------------------------------------- */

  function enqueue(job) {
    if (!SET.hasApi()) { job.fail('no-endpoint'); return; }   // on-device already answered
    health.sent++;

    if (Date.now() < quotaBlockedUntil) { job.fail('quota'); return; }
    queue.push(job);
    pump();
  }

  function pump() {
    if (inFlight >= MAX_FLIGHT || !queue.length) return;
    var wait = SET.get('pace') - (Date.now() - lastSent);
    if (wait > 0) { setTimeout(pump, wait); return; }

    var job = queue.shift();
    if (job.dead && job.dead()) { pump(); return; }   // the track vanished while queued

    inFlight++;
    lastSent = Date.now();

    post('/v1/identify', { image: job.image, hint: job.hint })
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'bad-response');
        return enrich(r, job.hint);
      })
      .then(function (rec) { job.done(rec); })
      .catch(function (e) {
        var msg = String(e && e.message || e);
        if (/429|quota|exhaust/i.test(msg)) {
          /* Back off for a minute rather than burning the rest of the day's
             free allowance on retries. */
          quotaBlockedUntil = Date.now() + 60000;
          queue.length = 0;
          U.toast('Daily free limit reached - identification paused for a minute');
        }
        job.fail(msg);
      })
      .then(function () { inFlight--; setTimeout(pump, 60); });
  }

  function post(path, body) {
    return U.fetchT(SET.api(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 20000).then(function (r) {
      if (r.status === 429) throw new Error('429 quota');
      return r.json().catch(function () { throw new Error('HTTP ' + r.status); });
    });
  }

  /* ---- enrichment ------------------------------------------------------ */

  /* Take the model's raw answer and turn it into the record the sheet draws.
     For a person this is where the living-public-figure gate is applied; a
     failed gate returns a record that deliberately carries NO name. */
  function enrich(r, hint) {
    var kind = r.kind || hint || 'object';
    var name = String(r.name || '').trim();
    var conf = typeof r.confidence === 'number' ? r.confidence : 0;

    var base = {
      kind: kind, name: name, confidence: conf,
      scientific: r.scientific || '', note: r.note || '',
      alt: r.alt || [], wiki: null, gated: ''
    };

    if (!name || conf < SET.get('conf')) {
      base.gated = 'low-confidence';
      base.name = '';
      return Promise.resolve(base);
    }

    if (kind === 'person') {
      if (!SET.get('faces')) { base.gated = 'faces-off'; base.name = ''; return Promise.resolve(base); }
      return WIKI.person(name).then(function (p) {
        if (!p.ok) {
          base.gated = p.reason;                 // deceased | no-article | not-a-person
          base.deceasedName = (p.reason === 'deceased') ? (p.name || name) : '';
          base.diedYear = p.diedYear || null;
          base.name = '';                        // never draw an ungated name
          return base;
        }
        base.wiki = p;
        base.name = p.name;
        return base;
      });
    }

    if (kind === 'plant' || kind === 'animal' || kind === 'insect') {
      return WIKI.taxon(r.scientific || name).then(function (t) {
        if (!t && r.scientific) return WIKI.taxon(name);
        return t;
      }).then(function (t) {
        base.wiki = t;
        if (t && t.scientific) base.scientific = t.scientific;
        return base;
      });
    }

    return WIKI.thing(name).then(function (t) { base.wiki = t; return base; });
  }

  /* ---- entry points ---------------------------------------------------- */

  function forTrack(t) {
    if (t.state !== 'new') return;
    var hint = kindOf(t.cls);

    /* People are opt-out; everything else always identifies. */
    if (hint === 'person' && !SET.get('faces')) {
      t.state = 'skipped'; t.reason = 'faces-off';
      t.kicker = 'Person';
      return;
    }

    var img = CAM.crop(t.raw, hint === 'person' ? 384 : 512, hint === 'person' ? 0.25 : 0.12);
    if (!img) { t.state = 'failed'; t.reason = 'no-frame'; return; }

    t.state = 'queued';
    t.kicker = KICKER[hint] || 'Object';
    t.tries++;

    enqueue({
      image: img,
      hint: hint,
      dead: function () { return !TRACK.byId(t.id); },
      done: function (rec) {
        health.ok++; health.lastAt = Date.now(); health.lastError = '';
        t.state = 'done';
        t.data = rec;
        /* The cloud only overwrites the on-device label when it actually has
           something better. A refusal must not blank a good local answer. */
        if (rec.name) { t.label = rec.name; t.tier = 'cloud'; }
        else if (t.local) { t.label = t.local.name; t.tier = 'local'; }
        t.reason = rec.gated || '';
        if (rec.kind && KICKER[rec.kind]) t.kicker = KICKER[rec.kind];
        UI.dirty();
      },
      fail: function (why) {
        if (why !== 'no-endpoint') { health.failed++; health.lastError = String(why || 'failed'); }
        t.state = 'failed';
        t.reason = why;
        if (t.local) { t.label = t.local.name; t.tier = 'local'; }   // fall back, never blank
        UI.dirty();
      }
    });
  }

  /* Tap anywhere: identify a square region around the tap. This is how
     insects, trees, flowers, fungi and anything else outside the 80 local
     classes get named. */
  function atPoint(sx, sy) {
    var m = CAM.coverMap();
    var fx = (SET.get('facing') === 'user' ? (m.ew - sx) : sx);
    var x = (fx - m.dx) / m.scale;
    var y = (sy - m.dy) / m.scale;

    var side = Math.min(m.vw, m.vh) * 0.42;
    var box = [
      U.clamp(x - side / 2, 0, m.vw - 1),
      U.clamp(y - side / 2, 0, m.vh - 1),
      side, side
    ];
    box[2] = Math.min(side, m.vw - box[0]);
    box[3] = Math.min(side, m.vh - box[1]);

    /* ON-DEVICE FIRST, ALWAYS. This is the unlimited path: no key, no quota,
       no account, works with the network off. The cloud is only asked when an
       endpoint exists, and only to sharpen what the device already said. */
    UI.openPending('Looking…');

    var fake = { id: -1, cls: 'object', box: box, raw: box, localState: '', local: null, tier: '', label: '' };
    LOCAL.label(U.$('#cam'), fake).then(function () {
      if (fake.local) {
        var kind = 'object';
        var look = WIKI.taxon(fake.local.name).then(function (w) {
          return (w && w.extract) ? w : WIKI.thing(fake.local.name);
        });
        look.then(function (w) {
          if (w && w.scientific) kind = 'plant';
          UI.openRecord({
            kind: kind, name: fake.local.name, confidence: fake.local.score,
            scientific: (w && w.scientific) || '', alt: fake.local.alt || [],
            wiki: w, source: 'on-device'
          });
        });
      }

      if (!SET.hasApi()) {
        if (!fake.local) UI.openError('nothing-found');
        return;
      }

      var img = CAM.crop(box, 640, 0.02, 0.78);
      if (!img) return;
      enqueue({
        image: img,
        hint: 'auto',
        done: function (rec) { if (rec && rec.name) UI.openRecord(rec); },
        fail: function (why) { if (!fake.local) UI.openError(why); }
      });
    });
  }

  /* Build a full detail record from an ON-DEVICE label alone. Wikipedia and
     Wikidata are keyless and CORS-open, so this path gives a photograph, a
     summary and an encyclopedia link with no API key configured at all. */
  function fromLocal(t) {
    var kind = kindOf(t.cls);
    var name = t.local.name;
    var rec = {
      kind: kind === 'person' ? 'object' : kind,
      name: name,
      confidence: t.local.score,
      scientific: '',
      note: '',
      alt: t.local.alt || [],
      wiki: null,
      source: 'on-device'
    };
    var look = (kind === 'animal' || kind === 'plant' || kind === 'insect') ? WIKI.taxon(name) : WIKI.thing(name);
    return look.then(function (w) {
      rec.wiki = w;
      if (w && w.scientific) rec.scientific = w.scientific;
      return rec;
    });
  }

  function status() {
    return { queued: queue.length, inFlight: inFlight, blocked: Date.now() < quotaBlockedUntil };
  }

  return { forTrack: forTrack, atPoint: atPoint, kindOf: kindOf, busy: busy, fromLocal: fromLocal,
           health: healthOf,
           status: status, KICKER: KICKER, post: post };
})();
