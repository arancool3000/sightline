/* Sightline - the map page.

   A map you can actually use: north-up and still, not turning under your
   hand with the compass. Drag it, pinch it, zoom it, switch off the parts
   you do not want. There is no fixed range - it draws as far out as you
   care to go and fetches the streets it has not got as you move.

   It is drawn from OpenStreetMap geometry, not from tiles: there is no tile
   server behind it, so nothing meters it and a street you have looked at
   once is still there with no signal.

   The 3D view stays where it belongs - the corner card, which is the one
   you glance at while walking.                                            */
'use strict';

var MAPVIEW = (function () {

  var cv = null, ctx = null, dpr = 1;
  var centre = null;            // { lat, lon }
  var mpp = 1.2;                // metres per pixel
  var MIN_MPP = 0.12, MAX_MPP = 600;
  var follow = true;            // recentre on the reader as they move
  /* Four, not five. A fifth chip did not fit a 390px screen: the row
     scrolled and the last one was off the edge, which is a control you
     cannot reach. Labels belong to places anyway - a named dot with its
     name hidden is a worse dot, not a different layer. */
  var layers = { map: 1, places: 1, route: 1 };
  var hits = [];                // what is on screen and tappable
  var fetched = {};             // road tiles asked for this session, to stay polite

  function state() {
    return { centre: centre, mpp: mpp, follow: follow, layers: layers,
             scale: scaleLabel() };
  }

  /* ---- projection ----

     Web Mercator, because the ground is now a picture and the picture is
     Mercator. "map is very slow loading. it should use tiles from osm."
     Overpass is a query service - seconds a request, two at a time, never
     meant to draw a map. OpenStreetMap's own tile servers hand out the
     same streets pre-rendered and CDN-cached in tens of milliseconds, so
     the map page draws those and asks Overpass for road geometry only when
     a route needs it.

     Everything drawn on top goes through the same projection as the tiles,
     at the same fractional zoom, so a road on the picture and the route
     drawn over it cannot disagree by a pixel. */
  var TILE_PX = 256;
  function zoomFor() { return Math.log(156543.03392 * Math.cos(centre.lat * Math.PI / 180) / mpp) / Math.LN2; }
  function tileZoom() { return Math.max(3, Math.min(19, Math.round(zoomFor()))); }
  function merc(lat, lon, z) {
    var n = TILE_PX * Math.pow(2, z);
    var s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
    return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }
  function unmerc(x, y, z) {
    var n = TILE_PX * Math.pow(2, z);
    return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI, x / n * 360 - 180];
  }
  function toScreen(pt, w, h) {
    var z = tileZoom(), sc = Math.pow(2, zoomFor() - z);
    var c = merc(centre.lat, centre.lon, z), p = merc(pt[0], pt[1], z);
    return [w / 2 + (p[0] - c[0]) * sc, h / 2 + (p[1] - c[1]) * sc];
  }
  function toWorld(x, y, w, h) {
    var z = tileZoom(), sc = Math.pow(2, zoomFor() - z);
    var c = merc(centre.lat, centre.lon, z);
    return unmerc(c[0] + (x - w / 2) / sc, c[1] + (y - h / 2) / sc, z);
  }

  /* ---- the tiles ----

     Kept in memory, a few hundred at most, oldest out first. A tile that
     arrives asks for one redraw; a hundred arriving in the same frame ask
     for one redraw. Cross-origin is declared so the canvas is not tainted
     - OpenStreetMap sends the header - and the picture is inverted into
     the HUD's dark palette on the way in. */
  var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var TILE_MAX = 400;
  var tiles = {}, tileOrder = [], tilePending = 0, tileAsked = 0, raf = 0;

  function tile(z, x, y) {
    var n = Math.pow(2, z);
    x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    var k = z + '/' + x + '/' + y, t = tiles[k];
    if (t) return t;
    var img = new Image();
    t = { img: img, ok: false, err: false };
    tiles[k] = t; tileOrder.push(k); tilePending++; tileAsked++;
    img.crossOrigin = 'anonymous';
    img.onload = function () { t.ok = true; tilePending--; redrawSoon(); };
    img.onerror = function () { t.err = true; tilePending--; redrawSoon(); };
    img.src = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    while (tileOrder.length > TILE_MAX) delete tiles[tileOrder.shift()];
    return t;
  }
  function redrawSoon() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; draw(); });
  }
  function drawTiles(w, h) {
    var z = tileZoom(), sc = Math.pow(2, zoomFor() - z), c = merc(centre.lat, centre.lon, z);
    var px = TILE_PX * sc;
    var x0 = Math.floor((c[0] - (w / 2) / sc) / TILE_PX), x1 = Math.floor((c[0] + (w / 2) / sc) / TILE_PX);
    var y0 = Math.floor((c[1] - (h / 2) / sc) / TILE_PX), y1 = Math.floor((c[1] + (h / 2) / sc) / TILE_PX);
    var drawn = 0;
    ctx.save();
    try { ctx.filter = 'invert(1) hue-rotate(180deg) brightness(.82) saturate(.7)'; } catch (e) {}
    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        var t = tile(z, tx, ty);
        if (!t || !t.ok) continue;
        var sx = w / 2 + (tx * TILE_PX - c[0]) * sc, sy = h / 2 + (ty * TILE_PX - c[1]) * sc;
        try { ctx.drawImage(t.img, sx, sy, px + 0.6, px + 0.6); drawn++; } catch (e) {}
      }
    }
    ctx.restore();
    return drawn;
  }

  /* ---- the canvas ---- */

  function size() {
    if (!cv) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = cv.clientWidth || 320, h = cv.clientHeight || 320;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init() {
    cv = document.getElementById('mapCanvas');
    if (!cv) return;
    ctx = cv.getContext('2d');
    size();
    wire();
    GEO.on(function () {
      if (!centre || follow) { var p = GEO.state().pos; if (p) centre = { lat: p.lat, lon: p.lon }; }
      draw();
    });
    ROADS.on(draw);
    window.addEventListener('resize', function () { size(); draw(); });
  }

  /* ---- moving about ---- */

  function wire() {
    var pointers = {}, pinch = 0, pinchMpp = 0, moved = false;

    cv.addEventListener('pointerdown', function (e) {
      cv.setPointerCapture(e.pointerId);
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      moved = false;
      if (Object.keys(pointers).length === 2) { pinch = spread(pointers); pinchMpp = mpp; }
    });

    cv.addEventListener('pointermove', function (e) {
      var p = pointers[e.pointerId];
      if (!p) return;
      var ids = Object.keys(pointers);

      if (ids.length === 2) {
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        var now = spread(pointers);
        if (pinch > 8 && now > 8) {
          setMpp(pinchMpp * (pinch / now));
          moved = true;
          draw();
        }
        return;
      }

      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (!centre) return;
      /* Dragging the map moves the ground under your finger, so the centre
         goes the other way. */
      centre = {
        lat: centre.lat + dy * mpp / M_PER_LAT,
        lon: centre.lon - dx * mpp / mPerLon(centre.lat)
      };
      follow = false;
      syncFollow();
      draw();
    });

    function up(e) {
      delete pointers[e.pointerId];
      if (Object.keys(pointers).length < 2) pinch = 0;
      if (!moved) tap(e);
    }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', function (e) { delete pointers[e.pointerId]; });

    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      setMpp(mpp * (e.deltaY > 0 ? 1.22 : 0.82));
      draw();
    }, { passive: false });

    bind('mapZoomIn', function () { setMpp(mpp * 0.6); draw(); });
    bind('mapZoomOut', function () { setMpp(mpp * 1.65); draw(); });
    bind('mapFollow', function () {
      var p = GEO.state().pos;
      if (p) { centre = { lat: p.lat, lon: p.lon }; follow = true; syncFollow(); draw(); }
    });

    Object.keys(layers).forEach(function (k) {
      bind('layer-' + k, function (btn) {
        layers[k] = layers[k] ? 0 : 1;
        btn.setAttribute('aria-pressed', layers[k] ? 'true' : 'false');
        draw();
      });
    });
  }

  function bind(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', function () { fn(el); });
  }
  function syncFollow() {
    var el = document.getElementById('mapFollow');
    if (el) el.setAttribute('aria-pressed', follow ? 'true' : 'false');
  }
  function spread(pts) {
    var k = Object.keys(pts);
    var a = pts[k[0]], b = pts[k[1]];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function setMpp(v) { mpp = Math.max(MIN_MPP, Math.min(MAX_MPP, v)); }

  function tap(e) {
    var r = cv.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    var best = null, bd = 30;
    hits.forEach(function (h) {
      var d = Math.hypot(h.x - x, h.y - y);
      if (d < bd) { bd = d; best = h; }
    });
    if (best) { MAP.setDest(best.p); draw(); return; }
    /* Nowhere in particular: make wherever you tapped the destination, which
       is how you say "over there" on a map. */
    var w = cv.clientWidth, h2 = cv.clientHeight;
    var pt = toWorld(x, y, w, h2);
    var p = GEO.state().pos;
    MAP.setDest({
      title: 'Dropped pin', lat: pt[0], lon: pt[1],
      dist: p ? Math.round(GEO.metres(p, { lat: pt[0], lon: pt[1] })) : 0,
      bearing: p ? GEO.bearing(p, { lat: pt[0], lon: pt[1] }) : 0
    });
    draw();
  }

  /* ---- keeping the streets coming ----

     Overpass is run by volunteers, so this asks for the tile under the
     centre and its neighbours only while the view is close enough for that
     to be a reasonable amount of ground, and never twice for the same
     tile. */
  function feed(w, h) {
    if (!centre) return;
    /* Road GEOMETRY is only for routing now - the picture comes from the
       tiles. So Overpass is not asked at all until there is somewhere to
       go, and never for footprints from this page. */
    if (!(window.MAP && MAP.dest && MAP.dest())) return;
    var acrossM = w * mpp;
    if (acrossM > 2600) return;                  // too wide to fetch politely
    var stepLat = 0.0064, stepLon = 0.0064 / Math.max(0.2, Math.cos(centre.lat * Math.PI / 180));
    var rows = acrossM > 1200 ? 1 : 0;
    for (var dy = -rows; dy <= rows; dy++) {
      for (var dx = -rows; dx <= rows; dx++) {
        var la = centre.lat + dy * stepLat, lo = centre.lon + dx * stepLon;
        var k = Math.floor(la / stepLat) + ',' + Math.floor(lo / stepLon);
        if (fetched[k]) continue;
        fetched[k] = 1;
        ROADS.ensure(la, lo, false);
      }
    }
  }

  /* ---- drawing ---- */

  var ROAD_COL = {
    motorway: '#ffb37a', trunk: '#ffc79a', primary: '#ffd9b0',
    secondary: '#cfe3ff', tertiary: '#bcd8ff'
  };

  function draw() {
    if (!ctx || !cv) return;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!centre) {
      var p = GEO.state().pos;
      if (p) centre = { lat: p.lat, lon: p.lon };
    }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a1118';
    ctx.fillRect(0, 0, w, h);

    if (!centre) {
      msg(ctx, w, h, GEO.state().error || 'Finding you…');
      return;
    }
    feed(w, h);
    hits = [];

    var pad = 80;
    function visible(x, y) { return x > -pad && x < w + pad && y > -pad && y < h + pad; }

    /* The picture. */
    var drawnTiles = layers.map ? drawTiles(w, h) : 0;

    /* The streets as lines are the fallback for when there is no picture -
       offline, or before the first tile lands - and only then. Drawn over
       a tile they are a second copy of the same road, slightly off. */
    var ways = ROADS.near();
    if (layers.map && drawnTiles === 0 && ways.length) {
      [true, false].forEach(function (casing) {
        for (var k = 0; k < ways.length; k++) {
          var wy = ways[k];
          var px = Math.max(1, ROADS.width(wy.k) * (casing ? 1.9 : 1.1) * Math.min(3, 2.4 / Math.max(0.4, mpp)) + (casing ? 1.6 : 0));
          if (!casing && mpp > 14 && ROADS.width(wy.k) < 3) continue;   // thin roads vanish when far out
          ctx.beginPath();
          var seen = false;
          for (var j = 0; j < wy.pts.length; j++) {
            var s2 = toScreen(wy.pts[j], w, h);
            if (visible(s2[0], s2[1])) seen = true;
            if (!j) ctx.moveTo(s2[0], s2[1]); else ctx.lineTo(s2[0], s2[1]);
          }
          if (!seen) continue;
          ctx.strokeStyle = casing ? 'rgba(6,12,20,.9)' : (ROAD_COL[wy.k] || 'rgba(198,224,255,.72)');
          ctx.lineWidth = px;
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.stroke();
        }
      });
    }

    /* The route, over the streets it follows. */
    var rt = ROUTE.get();
    if (layers.route && rt) {
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      rt.legs.forEach(function (leg, li) {
        ctx.beginPath();
        leg.pts.forEach(function (pt, i2) {
          var s3 = toScreen(pt, w, h);
          if (!i2) ctx.moveTo(s3[0], s3[1]); else ctx.lineTo(s3[0], s3[1]);
        });
        ctx.strokeStyle = li < rt.leg ? 'rgba(79,227,255,.28)' : '#4fe3ff';
        ctx.lineWidth = Math.max(3, 8 / Math.max(0.5, mpp));
        ctx.globalAlpha = 0.9;
        ctx.stroke();
      });
      ctx.restore();
    }

    /* Places, and the destination. */
    if (layers.places) {
      var st = GEO.state();
      st.places.forEach(function (p) {
        var s4 = toScreen([p.lat, p.lon], w, h);
        if (!visible(s4[0], s4[1])) return;
        hits.push({ x: s4[0], y: s4[1], p: p });
        var on = MAP.dest() && MAP.dest().title === p.title;
        ctx.fillStyle = on ? '#ffb347' : '#7fd8ff';
        ctx.beginPath(); ctx.arc(s4[0], s4[1], on ? 6 : 4, 0, Math.PI * 2); ctx.fill();
        if (mpp < 9) {
          ctx.fillStyle = 'rgba(230,236,241,.9)';
          ctx.font = '500 11px -apple-system,system-ui,sans-serif';
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(p.title.length > 26 ? p.title.slice(0, 25) + '…' : p.title, s4[0] + 9, s4[1]);
        }
      });
      var d = MAP.dest();
      if (d) {
        var sd = toScreen([d.lat, d.lon], w, h);
        ctx.save();
        ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sd[0], sd[1], 10, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sd[0], sd[1] - 16); ctx.lineTo(sd[0], sd[1] - 4); ctx.stroke();
        ctx.restore();
      }
    }

    /* You, and which way you are facing - a mark on a still map, not the
       map turning round you. */
    var me = GEO.state();
    if (me.pos) {
      var s5 = toScreen([me.pos.lat, me.pos.lon], w, h);
      ctx.save();
      if (me.pos.acc) {
        var ar = me.pos.acc / mpp;
        if (ar > 4) {
          ctx.fillStyle = 'rgba(79,227,255,.12)';
          ctx.beginPath(); ctx.arc(s5[0], s5[1], Math.min(ar, Math.max(w, h)), 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.translate(s5[0], s5[1]);
      if (typeof me.heading === 'number') ctx.rotate(me.heading * Math.PI / 180);
      ctx.fillStyle = '#4fe3ff';
      ctx.beginPath();
      ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-6, 7);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    /* North, so a still map still says which way is up. */
    ctx.save();
    ctx.fillStyle = 'rgba(190,225,255,.6)';
    ctx.font = '600 11px ui-monospace,Menlo,monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', w - 20, 22);
    ctx.beginPath(); ctx.moveTo(w - 20, 30); ctx.lineTo(w - 20, 42);
    ctx.moveTo(w - 24, 34); ctx.lineTo(w - 20, 28); ctx.lineTo(w - 16, 34);
    ctx.strokeStyle = 'rgba(190,225,255,.5)'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.restore();

    scaleBar(ctx, w, h);
    waiting(ctx, w, h);
    /* Required by the people whose map this is. */
    ctx.save();
    ctx.font = '500 9px -apple-system,system-ui,sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(200,225,245,.6)';
    ctx.fillText('\u00a9 OpenStreetMap contributors', w - 8, h - 6);
    ctx.restore();
    var note = document.getElementById('mapScale');
    if (note && note.textContent !== scaleLabel()) note.textContent = scaleLabel();
  }

  /* An empty square and a square that is still filling look the same, and
     one of them is broken. Say which this is, and say what is missing -
     streets arriving before boxes is the design, not a fault. */
  function waiting(ctx2, w, h) {
    var p = ROADS.pending ? ROADS.pending() : { roads: 0, buildings: 0, queued: 0 };
    var n = tilePending + p.roads + p.queued;
    if (!n) return;
    var what = tilePending ? 'Loading map' : 'Loading route';
    if (n > 1) what += ' (' + n + ')';
    ctx2.save();
    ctx2.font = '600 11px ui-monospace,Menlo,monospace';
    var tw = ctx2.measureText(what).width;
    ctx2.fillStyle = 'rgba(6,12,18,.72)';
    ctx2.fillRect(12, h - 30, tw + 18, 20);
    ctx2.fillStyle = 'rgba(190,225,255,.85)';
    ctx2.textAlign = 'left';
    ctx2.fillText(what, 21, h - 16);
    ctx2.restore();
  }

  function msg(ctx2, w, h, t) {
    ctx2.fillStyle = 'rgba(230,236,241,.5)';
    ctx2.font = '500 12px -apple-system,system-ui,sans-serif';
    ctx2.textAlign = 'center'; ctx2.textBaseline = 'middle';
    ctx2.fillText(t, w / 2, h / 2);
  }

  /* A round number of metres, and the bar that long. */
  var STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  function niceLen(w) {
    var want = w * 0.26 * mpp;
    for (var i = STEPS.length - 1; i >= 0; i--) if (STEPS[i] <= want) return STEPS[i];
    return STEPS[0];
  }
  function scaleLabel() {
    var m = niceLen(cv ? cv.clientWidth : 320);
    return m >= 1000 ? (m / 1000) + ' km' : m + ' m';
  }
  function scaleBar(ctx2, w, h) {
    var m = niceLen(w), px = m / mpp;
    var x = 14, y = h - 16;
    ctx2.save();
    ctx2.strokeStyle = 'rgba(230,236,241,.75)';
    ctx2.lineWidth = 2;
    ctx2.beginPath();
    ctx2.moveTo(x, y - 5); ctx2.lineTo(x, y); ctx2.lineTo(x + px, y); ctx2.lineTo(x + px, y - 5);
    ctx2.stroke();
    ctx2.fillStyle = 'rgba(230,236,241,.85)';
    ctx2.font = '600 10px ui-monospace,Menlo,monospace';
    ctx2.textAlign = 'left'; ctx2.textBaseline = 'bottom';
    ctx2.fillText(m >= 1000 ? (m / 1000) + ' km' : m + ' m', x + 3, y - 7);
    ctx2.restore();
  }

  function frame(pts) {
    /* Fit a set of points, used when a route is planned. */
    if (!pts || !pts.length || !cv) return;
    var minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    pts.forEach(function (p) {
      minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]);
      minLon = Math.min(minLon, p[1]); maxLon = Math.max(maxLon, p[1]);
    });
    centre = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
    var w = cv.clientWidth || 320, h = cv.clientHeight || 320;
    var needX = (maxLon - minLon) * mPerLon(centre.lat) / (w * 0.8);
    var needY = (maxLat - minLat) * M_PER_LAT / (h * 0.8);
    setMpp(Math.max(0.4, needX, needY));
    follow = false;
    syncFollow();
    draw();
  }

  return { init: init, draw: draw, size: size, state: state, frame: frame,
           _tiles: function () { return { asked: tileAsked, pending: tilePending, held: tileOrder.length, zoom: tileZoom() }; },
           setMpp: setMpp, toScreen: function (pt) { return toScreen(pt, cv.clientWidth, cv.clientHeight); },
           _tap: tap, _centre: function (c) { if (c) { centre = c; follow = false; } return centre; } };
})();
