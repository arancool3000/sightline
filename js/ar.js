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

  /* Rough, and labelled as such. Apparent size against a typical real size,
     with a focal length assumed from a normal phone field of view. It is an
     estimate and the card says so with a "~". */
  function distance(cls, boxW, boxH, frameW) {
    var real = SIZE[cls];
    if (!real || !frameW) return '';
    var px = Math.max(boxW, boxH);
    if (px < 8) return '';
    var focal = frameW * 0.85;
    var d = (real * focal) / px;
    if (d < 0.25 || d > 120) return '';
    return d < 10 ? ('~' + d.toFixed(1) + ' m') : ('~' + Math.round(d) + ' m');
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
  function place(t, screen, kind, frameW) {
    if (!layer) return;
    var el = cards[t.id] || build(t.id, kind);
    seen[t.id] = 1;

    var named = !!t.label;
    var provisional = named && t.tier !== 'cloud';
    var title = named ? t.label
              : (t.scan === 'scanning' ? 'Scanning' :
                 t.scan === 'dismissed' ? (t.why || 'Dismissed') : String(t.cls));
    var sub = (t.data && t.data.scientific) ||
              (t.data && t.data.specs && t.data.specs.length ? t.data.specs[0].v : '') ||
              (named ? kind.charAt(0).toUpperCase() + kind.slice(1) : '');
    var dist = distance(t.cls, screen[2], screen[3], frameW);

    var tEl = el.querySelector('.ar-title');
    if (tEl.textContent !== title) tEl.textContent = title;
    var sEl = el.querySelector('.ar-sub');
    if (sEl.textContent !== sub) sEl.textContent = sub;
    var dEl = el.querySelector('.ar-dist');
    if (dEl.textContent !== dist) dEl.textContent = dist;

    var cls = 'ar-card k-' + kind +
      (named ? ' named' : '') +
      (provisional ? ' prov' : '') +
      (t.scan === 'dismissed' && !named ? ' dim' : '') +
      (t.scan === 'scanning' && !named ? ' scan' : '');
    if (el.className !== cls) el.className = cls;

    /* Anchor above the object, kept inside the viewport. */
    var w = layer.clientWidth, h = layer.clientHeight;
    var cw = el.offsetWidth || 150, ch = el.offsetHeight || 44;
    var x = screen[0] + screen[2] / 2 - cw / 2;
    var y = screen[1] - ch - 18;
    if (y < 6) y = Math.min(screen[1] + screen[3] + 14, h - ch - 6);
    x = Math.max(6, Math.min(x, w - cw - 6));

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

  return { init: init, place: place, sweep: sweep, clear: clear,
           HUE: HUE, distance: distance, SIZE: SIZE };
})();
