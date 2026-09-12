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
      headers: SET.apiHeaders(),
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
  /* The model only has to propose a person; WIKI.person decides. Below
     this it is not a proposal, it is noise. */
  var PERSON_FLOOR = 0.30;

  /* Each candidate through the same gate, in order. The FIRST refusal is
     what gets reported if they all fail, because that is the one about the
     model's actual answer - "no article for the third runner-up" would
     explain nothing. */
  function tryPeople(names, i, base) {
    if (i >= names.length) return Promise.resolve(base);
    return WIKI.person(names[i]).then(function (p) {
      if (p.ok) {
        base.wiki = p;
        base.name = p.name;
        base.gated = '';
        base.viaAlt = i > 0 ? names[0] : '';
        return base;
      }
      if (i === 0) {
        base.gated = p.reason;                   // deceased | no-article | not-a-person
        base.deceasedName = (p.reason === 'deceased') ? (p.name || names[0]) : '';
        base.diedYear = p.diedYear || null;
        base.name = '';                          // never draw an ungated name
      }
      return tryPeople(names, i + 1, base);
    }, function () { return tryPeople(names, i + 1, base); });
  }

  function enrich(r, hint) {
    var kind = r.kind || hint || 'object';
    var name = String(r.name || '').trim();
    var conf = typeof r.confidence === 'number' ? r.confidence : 0;

    var base = {
      kind: kind, name: name, confidence: conf,
      scientific: r.scientific || '', note: r.note || '',
      alt: r.alt || [], wiki: null, gated: ''
    };

    /* WHY A PERSON HAS A DIFFERENT FLOOR.

       "must be able to easily identify movie stars etc."

       The confidence floor is the MODEL'S OWN opinion of itself, and it
       exists because for an object nothing else checks the answer. For a
       person something else does, and it is much stronger than a number:
       the name has to resolve to a living human with a Wikipedia article
       and a Wikidata entity. Requiring 0.75 of self-belief AND that check
       is belt and braces to the point of refusing everybody - a model told
       "never guess at a person" hedges by design and rarely says 0.75, so
       actors were being thrown away before Wikipedia was ever asked.

       So the model only has to PROPOSE here. The encyclopedia decides. A
       name still cannot reach the screen without it. */
    var floor = (kind === 'person') ? PERSON_FLOOR : SET.get('conf');
    if (!name || conf < floor) {
      base.gated = 'low-confidence';
      base.name = '';
      return Promise.resolve(base);
    }

    if (kind === 'person') {
      if (!SET.get('faces')) { base.gated = 'faces-off'; base.name = ''; return Promise.resolve(base); }
      /* AND THE RUNNERS-UP GET A TURN.

         A face the model is torn over comes back with the right person
         second: it returns up to three, and only the first was ever
         checked. Each is put to the same gate, in order, and the first
         that is a living public figure wins. A wrong first guess is no
         longer the end of it - and nothing gets through that the gate
         would not have passed on its own. */
      var tries = [name].concat(
        (base.alt || []).map(function (a) { return String(a && a.name ? a.name : a).trim(); })
      ).filter(Boolean).slice(0, 3);

      return tryPeople(tries, 0, base);
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

  /* ---- A TAP IS A REQUEST, AND IT SPENDS THE GOOD MODEL ----

     "whenever you tap on an object it must use ai and fall back to
      wikipedia if out of free gemini. that only should happen when you
      tap on that object."

     Both halves matter. A tap is somebody asking, so it is worth a real
     answer from the best thing available - the reader's own Gemini key,
     straight from the device. And ONLY a tap: nothing on this path runs
     by itself, so a camera pointed at a busy street does not quietly
     spend an allowance nobody asked it to.

     When Gemini has no key, is turned away, or answers nothing useful,
     the old path is still there underneath: the on-device label resolved
     through Wikipedia, then the Worker. Falling back is not failing.

     ⚠ The prompt below says the same thing as the Worker's promptFor().
     They cannot share a file - one runs in a browser and one in a Worker,
     and there is no build step - so if you change what an answer should
     contain, change both. The SHAPE is enforced in one place either way:
     enrich() is what every answer goes through. */
  var TAP_RULES =
    'You are a precise visual identification engine. Identify the MAIN subject of this image.\n' +
    'Answer as JSON only: {"kind":"person|plant|animal|insect|vehicle|object","name":"","confidence":0.0,' +
    '"scientific":"","note":"","alt":["",""],"specs":[{"k":"","v":""}]}\n' +
    '- "confidence" is your honest probability from 0 to 1 that the name is exactly right.\n' +
    '- A generic noun is useless. "Chair", "printer", "laptop" tell the viewer nothing they cannot see: ' +
    'give the specific identity - the make, model and generation, the breed, the species.\n' +
    '- If nothing can be identified, return an empty name and confidence 0.\n';
  var TAP_HINT = {
    person: 'This is a person. Name them if they are a widely photographed public figure with a Wikipedia ' +
            'article. Put your best candidate in "name" and up to three others in "alt", best first - every ' +
            'one is checked against Wikipedia before anything is shown, so an uncertain candidate is worth ' +
            'offering. If this is an ordinary private individual, return an empty name and confidence 0.',
    plant:  'This is a plant, tree, flower or fungus. Common name in "name", binomial in "scientific".',
    animal: 'This is an animal. Species, or the breed for a domestic animal, in "name"; binomial in "scientific".',
    insect: 'This is an insect or other small invertebrate. Common name in "name", binomial in "scientific". ' +
            'Say in "note" whether it stings or bites.',
    vehicle:'This is a vehicle. Make, model and generation in "name" (for example "Subaru Impreza WRX (GC8)"). ' +
            'Production years and body style in "note".',
    object: 'This is a manufactured object. Give the full model name and manufacturer in "name". Fill "specs" ' +
            'with what someone looking at it would want, as {k,v} pairs, in this order where you can: ' +
            'Manufacturer, Model, Released, Price from, Where to buy, and one standout specification. ' +
            'Omit any row you are unsure of - a missing row is honest, an invented price is not.'
  };

  /* Only openTrack calls this. Answers a record, or null to mean "use the
     path that was already there". */
  function tapAsk(t) {
    if (!window.GEM || !GEM.has || !GEM.has()) return Promise.resolve(null);
    var hint = kindOf(t.cls);
    if (hint === 'person' && !SET.get('faces')) return Promise.resolve(null);
    var img = CAM.crop(t.raw, hint === 'person' ? 384 : 512, hint === 'person' ? 0.25 : 0.12);
    if (!img) return Promise.resolve(null);
    var prompt = TAP_RULES + (TAP_HINT[hint] || TAP_HINT.object);
    return GEM.ask(prompt, img, { json: true, maxTokens: 500, temperature: 0.1 })
      .then(function (r) {
        if (!r || !r.ok) return null;                    // no key, turned away, or nothing
        var raw = r.json;
        if (!raw) { try { raw = JSON.parse(r.text); } catch (e) { return null; } }
        if (!raw || typeof raw !== 'object') return null;
        raw.kind = raw.kind || hint;
        /* Same gate as every other answer: enrich() decides what may be
           shown, so a tap cannot name somebody the rest of the app would
           refuse to. */
        return enrich(raw, hint).then(function (rec) {
          rec.source = 'gemini';
          rec.model = r.model;
          return rec;
        });
      }, function () { return null; });
  }

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
      margin: t.local.margin,
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
           status: status, KICKER: KICKER, post: post, _enrich: enrich, tapAsk: tapAsk };
})();
