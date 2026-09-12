/* Sightline - the AR layer.

   Geometry is drawn on the canvas (the dot on the object, the leader line,
   the outline). The CARD is a DOM element, because a card wants an icon,
   two weights of type and a rounded translucent panel, and canvas is a poor
   way to get any of that.

   Cards are recycled per track id and moved with a transform, so a scene
   with a dozen targets does not rebuild the DOM every frame. */
'use strict';

var AR = (function () {

  var layer = null;
  var cards = {};          // track id -> element
  var seen = {};
  var taken = [];          // rectangles already occupied this frame
  var reserved = [];       // the HUD's own furniture, which cards must dodge

  /* Typical largest real-world dimension, in metres, for classes where a
     sensible prior exists. Anything not listed gets NO distance rather than
     an invented one. */
  var SIZE = {
    person: 1.7, bicycle: 1.7, car: 4.4, motorcycle: 2.1, bus: 11, truck: 7,
    'traffic light': 0.9, bench: 1.5, bird: 0.25, cat: 0.45, dog: 0.6,
    horse: 2.2, sheep: 1.2, cow: 2.2, backpack: 0.5, umbrella: 1.0,
    handbag: 0.35, suitcase: 0.65, bottle: 0.25, 'wine glass': 0.18,
    cup: 0.1, fork: 0.19, knife: 0.22, spoon: 0.17, bowl: 0.22,
    chair: 0.9, couch: 2.0, 'potted plant': 0.4, bed: 2.0,
    'dining table': 1.4, toilet: 0.7, tv: 1.1, laptop: 0.34, mouse: 0.11,
    remote: 0.17, keyboard: 0.44, 'cell phone': 0.15, microwave: 0.5,
    oven: 0.6, toaster: 0.3, sink: 0.6, refrigerator: 1.75, book: 0.24,
    clock: 0.3, vase: 0.3, scissors: 0.2, 'teddy bear': 0.4
  };

  var ICON = {
    person:  'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    animal:  'M4 14c0-3 2-5 4-5s4 2 4 5M14 9c2 0 4 2 4 5M6 19h12',
    plant:   'M12 21V9M12 9c0-3 2-5 5-5 0 3-2 5-5 5zM12 13c0-3-2-5-5-5 0 3 2 5 5 5z',
    insect:  'M12 7v10M8 9l-4-2M8 15l-4 2M16 9l4-2M16 15l4 2M12 7a3 3 0 1 1 0-4 3 3 0 0 1 0 4z',
    vehicle: 'M3 13l2-5h14l2 5v5h-3M6 18H3v-5M7 18a2 2 0 1 0 4 0 2 2 0 0 0-4 0M15 18a2 2 0 1 0 4 0 2 2 0 0 0-4 0',
    object:  'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 21V12M4 7.5L12 12l8-4.5'
  };

  var HUE = {
    person: '#8ab4ff', animal: '#ff8fd0', plant: '#5ddc8c',
    insect: '#ffb347', vehicle: '#7aa2ff', object: '#4fe3ff'
  };

  function init() {
    layer = document.getElementById('arLayer');
  }

  /* Called once a frame before any placing. The HUD's corners hold the
     telemetry, the clock, the scan log and the instruments; a card that
     slides under them is unreadable, so they are treated as occupied. */
  function begin() {
    taken = [];
    reserved = [];
    ['hudTL', 'hudTR', 'radarPod', 'nearCard', 'sceneChip', 'captionBar'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || el.hidden || !el.offsetWidth) return;
      var r = el.getBoundingClientRect();
      reserved.push([r.left - 6, r.top - 6, r.width + 12, r.height + 12]);
    });
    taken = reserved.slice();
  }

  function hits(a, b) {
    return a[0] < b[0] + b[2] && a[0] + a[2] > b[0] &&
           a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
  }
  function clashes(r) {
    for (var i = 0; i < taken.length; i++) if (hits(r, taken[i])) return true;
    return false;
  }

  /* Several things identified at once is the whole point, so the cards have
     to share the screen. A card that would land on top of another - or on
     the telemetry - is stepped away until it finds room, preferring to stay
     near its own object. */
  function findRoom(x, y, cw, ch, w, h, objTop, objBottom) {
    var tries = [[x, y]];
    var step = ch + 6;
    for (var k = 1; k <= 4; k++) {
      tries.push([x, y - step * k]);                 // stack upward
      tries.push([x, objBottom + 14 + step * (k - 1)]);   // or below the object
    }
    for (var j = 0; j < tries.length; j++) {
      var tx = Math.max(6, Math.min(tries[j][0], w - cw - 6));
      var ty = Math.max(6, Math.min(tries[j][1], h - ch - 6));
      if (!clashes([tx, ty, cw, ch])) return [tx, ty];
    }
    /* Nowhere clean: keep it on its object rather than hiding the answer. */
    return [Math.max(6, Math.min(x, w - cw - 6)), Math.max(6, Math.min(y, h - ch - 6))];
  }

  /* Rough, and labelled as such. Apparent size against a typical real size,
     with a focal length assumed from a normal phone field of view. It is an
     estimate and the card says so with a "~". */
  var PREFER = [/price|cost|from\b/i, /manufacturer|maker|brand/i, /model/i];
  function specLine(data) {
    var rows = data && data.specs;
    if (!rows || !rows.length) return '';
    for (var p = 0; p < PREFER.length; p++) {
      for (var i = 0; i < rows.length; i++) {
        if (PREFER[p].test(rows[i].k || '')) return String(rows[i].v || '');
      }
    }
    return String(rows[0].v || '');
  }

  function sentence(w) {
    w = String(w || '').replace(/[_-]+/g, ' ');
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  function distance(cls, boxW, boxH, frameW) {
    var real = SIZE[cls];
    if (!real || !frameW) return '';
    var px = Math.max(boxW, boxH);
    if (px < 8) return '';
    var focal = frameW * 0.85;
    var d = (real * focal) / px;
    if (d < 0.25 || d > 120) return '';
    return d < 10 ? ('\u2248 ' + d.toFixed(1) + ' m') : ('\u2248 ' + Math.round(d) + ' m');
  }

  function build(id, kind) {
    var el = document.createElement('div');
    el.className = 'ar-card';
    el.innerHTML =
      '<span class="ar-ic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="' + (ICON[kind] || ICON.object) + '"/></svg></span>' +
      '<span class="ar-txt"><b class="ar-title"></b>' +
      '<i class="ar-sub"></i><i class="ar-dist"></i></span>';
    layer.appendChild(el);
    cards[id] = el;
    return el;
  }

  /* One card per target. Written guarded so a steady scene does no DOM work
     beyond moving things. */
  /* IS THERE ANYTHING WORTH SAYING?

     "this is not for LABELLING THE OBVIOUS. IT IS FOR LABELLING SPECIES AND
      MODELS AND THINGS THAT ARE NOT OBVIOUS. I KNOW WHAT A TENNIS BALL IS."

     So a card is not the reward for detecting something. It is the reward
     for knowing something the person holding the camera does not: a species,
     a make and model, a price, a name. A detected object with nothing but
     its own generic noun attached gets a marker and no words.

     Three things clear the bar:
       - an answer from the detail tier, which is asked for the specific
         identity and told a generic noun is useless;
       - an on-device label that says MORE than the box did - "Golden
         Retriever" over "dog";
       - nothing else. A crop of the scene classified as "Tennis Ball" is
         the thing this rule exists to stop.                               */
  function worthSaying(t) {
    /* TORN IS AN ANSWER.

       When the model cannot separate its top few, that is not a failure to
       report - it is the most truthful thing available, and for a
       crossbreed or a cultivar it is the ONLY true thing: "a cross of
       these". So it earns a card, in its own quieter style. */
    if (t.torn && t.among && t.among.length > 1 && EVIDENCE.adds(t.among[0], t.cls)) return true;
    if (!t.label) return false;
    /* An answer still being weighed is not an answer. */
    if (t.unsure) return false;
    if (!EVIDENCE.adds(t.label, t.cls)) return false;
    /* A guess about a square of the scene is never specific enough to
       deserve words on screen. */
    if (t.tier === 'guess') return false;
    return EVIDENCE.rank(t.tier) >= EVIDENCE.rank('local');
  }

  function place(t, screen, kind, frameW) {
    if (!layer) return;

    if (!worthSaying(t)) {
      /* Drop any card this target used to have, so an answer that is
         withdrawn does not leave its words behind. */
      if (cards[t.id]) {
        var old = cards[t.id];
        if (old.parentNode) old.parentNode.removeChild(old);
        delete cards[t.id];
      }
      return null;
    }
    var el = cards[t.id] || build(t.id, kind);
    seen[t.id] = 1;

    var named = true;                       // nothing reaches here unnamed
    /* An on-device answer the model was torn over is shown as unsettled -
       dashed, with the mark - rather than in the same type as a confident
       one. It is still the best guess; it is just not presented as a fact. */
    var provisional = EVIDENCE.rank(t.tier) < EVIDENCE.rank('species') || !!t.unsure;
    var guess = t.tier === 'guess';
    /* A target that has not been named yet shows the plain noun the
       detector gave, not a state machine. "SCANNING" and a percentage told
       the reader about our process; the noun tells them about the world. */
    var torn = !!(t.torn && t.among && t.among.length > 1);
    var title = torn ? ('A cross of ' + sentence(t.among[0]) + '?') : sentence(t.label);
    /* What the second line says is a claim about how much to trust the
       first one. A confirmed identification gets its detail; a guess from a
       crop of the scene says so, with the number. */
    /* The second line answers the question the owner actually asks of an
       object: what is it and what does it cost. A price beats the maker,
       the maker beats the category. A living thing gets its binomial. */
    if (torn) {
      /* Name the others. A shortlist is information; a wrong winner is not. */
      var sub2 = 'or ' + t.among.slice(1, 3).map(sentence).join(', ');
      var tEl0 = el.querySelector('.ar-title');
      if (tEl0.textContent !== title) tEl0.textContent = title;
      var sEl0 = el.querySelector('.ar-sub');
      if (sEl0.textContent !== sub2) sEl0.textContent = sub2;
      var dEl0 = el.querySelector('.ar-dist');
      var dist0 = distance(t.cls, screen[2], screen[3], frameW);
      if (dEl0.textContent !== dist0) dEl0.textContent = dist0;
      var cls0 = 'ar-card k-' + kind + ' named torn';
      if (el.className !== cls0) el.className = cls0;
      return position(el, screen, layer);
    }

    var sub = (t.species && t.species.scientific) ||
              (t.data && t.data.scientific) || specLine(t.data) ||
              (named ? sentence(kind) : '');
    var dist = distance(t.cls, screen[2], screen[3], frameW);

    var tEl = el.querySelector('.ar-title');
    if (tEl.textContent !== title) tEl.textContent = title;
    var sEl = el.querySelector('.ar-sub');
    if (sEl.textContent !== sub) sEl.textContent = sub;
    var dEl = el.querySelector('.ar-dist');
    if (dEl.textContent !== dist) dEl.textContent = dist;

    var cls = 'ar-card k-' + kind +
      (named ? ' named' : '') +
      (provisional && !guess ? ' prov' : '') +
      (guess ? ' guess' : '') +
      (t.scan === 'dismissed' && !named ? ' dim' : '');
    if (el.className !== cls) el.className = cls;

    return position(el, screen, layer);
  }

  /* Where the card sits, which is the same question whatever it says. */
  function position(el, screen, layer) {
    var w = layer.clientWidth, h = layer.clientHeight;
    var cw = el.offsetWidth || 150, ch = el.offsetHeight || 44;
    var x = screen[0] + screen[2] / 2 - cw / 2;
    var y = screen[1] - ch - 18;
    if (y < 6) y = Math.min(screen[1] + screen[3] + 14, h - ch - 6);

    var spot = findRoom(x, y, cw, ch, w, h, screen[1], screen[1] + screen[3]);
    x = spot[0]; y = spot[1];
    taken.push([x, y, cw, ch]);

    var tr = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    if (el.style.transform !== tr) el.style.transform = tr;

    return [x + cw / 2, y + ch];      // where the leader line should meet it
  }

  /* Remove cards for targets that are gone. */
  function sweep() {
    Object.keys(cards).forEach(function (id) {
      if (seen[id]) return;
      var el = cards[id];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      delete cards[id];
    });
    seen = {};
  }

  function clear() {
    Object.keys(cards).forEach(function (id) {
      var el = cards[id];
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    cards = {}; seen = {};
  }

  return { init: init, begin: begin, place: place, sweep: sweep, clear: clear,
           worthSaying: worthSaying,
           HUE: HUE, distance: distance, SIZE: SIZE };
})();
