/* Sightline - the roads around you.

   Geometry comes from OpenStreetMap through Overpass. No key, no account,
   and the data is open. Overpass is a volunteer-run service with a fair-use
   policy rather than an unlimited one, so this asks it as little as it
   possibly can:

     - one request per tile of about 700 m, never per frame and never per
       position fix;
     - every tile is kept on the device, because roads do not move. A street
       you have walked down once is drawn from then on with no network at
       all, including with no signal;
     - a failure is not retried in a loop. It is remembered and left alone.

   If Overpass is unreachable the map still works: it just has your position,
   your heading and the places around you, which is what it had before.     */
'use strict';

var ROADS = (function () {

  var KEY = 'sightline.roads.v1';
  var ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  var TILE = 0.0064;            // degrees of latitude, about 700 m
  var MAX_TILES = 12;           // what is kept on the device - buildings are bulky
  var STALE_MS = 30 * 86400000; // a month; roads change, but not weekly

  var tiles = {};               // "lat,lon" -> { at, ways:[...], bld:[...] }
  var asking = {}, failedAt = {};
  var listeners = [];

  /* Which classes of road are worth drawing, and how wide. Anything not
     listed is not fetched at all - a map of every footpath and driveway is
     slower to fetch and harder to read. */
  var CLASS = {
    motorway: 5, trunk: 4.5, primary: 4, secondary: 3.4, tertiary: 3,
    residential: 2.4, unclassified: 2.2, living_street: 2, service: 1.6,
    pedestrian: 1.6, footway: 1.2, path: 1.1, cycleway: 1.2, steps: 1
  };

  function on(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) tiles = JSON.parse(raw) || {};
    } catch (e) { tiles = {}; }
  }
  function save() {
    try {
      /* Oldest out first when there are too many. */
      var keys = Object.keys(tiles);
      if (keys.length > MAX_TILES) {
        var stamp = function (k) { return Math.max(tiles[k].at || 0, tiles[k].bldAt || 0); };
        keys.sort(function (a, b) { return stamp(a) - stamp(b); });
        keys.slice(0, keys.length - MAX_TILES).forEach(function (k) { delete tiles[k]; });
      }
      localStorage.setItem(KEY, JSON.stringify(tiles));
    } catch (e) {
      /* Out of room: keep the newest few and try once more. */
      try {
        var ks = Object.keys(tiles).sort(function (a, b) {
          return Math.max(tiles[b].at || 0, tiles[b].bldAt || 0) -
                 Math.max(tiles[a].at || 0, tiles[a].bldAt || 0);
        });
        var keep = {};
        ks.slice(0, 4).forEach(function (k) { keep[k] = tiles[k]; });
        tiles = keep;
        localStorage.setItem(KEY, JSON.stringify(tiles));
      } catch (e2) { /* nothing more to do; the map still draws from memory */ }
    }
  }

  function tileKey(lat, lon) {
    var lonTile = TILE / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    return Math.floor(lat / TILE) + ',' + Math.floor(lon / lonTile);
  }
  function tileBox(lat, lon) {
    var lonTile = TILE / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    var y = Math.floor(lat / TILE), x = Math.floor(lon / lonTile);
    return [y * TILE, x * lonTile, (y + 1) * TILE, (x + 1) * lonTile];   // s,w,n,e
  }

  /* ---- ASKING OVERPASS, POLITELY AND IN THE RIGHT ORDER ----

     "map boxes load super slowly."

     Measured first: none of the wait is ours. With a 393 KB tile already in
     hand the first box is on screen in 55ms, a full redraw of 600 buildings
     and 120 roads is 6ms, and storing the tile is 0.8ms. The wait is the
     round trip, so what had to change is how it is asked for.

     THREE FAULTS, ALL IN THE ASKING:

     Overpass serves two requests at a time from one address and queues the
     rest. A wide view fired NINE at once, so seven were refused - and a
     refusal was treated as a verdict, blacklisting that tile for ten
     minutes. The one road you are standing on stayed blank. Now: two in
     flight, the rest in a queue, and a refusal is a wait.

     Roads and buildings came back in ONE response, so nothing appeared
     until all of it had. They are two requests now, roads first. Roads are
     a tenth of the bytes and they are what makes the picture a map; the
     boxes fill in behind them.

     And the buildings were fetched whether or not they would be drawn -
     with the layer switched off, or zoomed too far out to show them, the
     bytes came down anyway. Now the caller says whether it wants them. */

  var MAX_LIVE = 2;             // what Overpass serves one address at once
  var live = 0, queue = [];

  function pump() {
    while (live < MAX_LIVE && queue.length) {
      live++;
      queue.shift()().then(freeOne, freeOne);
    }
  }
  function freeOne() { live--; pump(); }
  function enqueue(job, first) {
    if (first) queue.unshift(job); else queue.push(job);
    pump();
  }
  function blocked(id) { return failedAt[id] && (Date.now() - failedAt[id]) < 600000; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Ask for a tile. Roads always; buildings only if they will be drawn. */
  function ensure(lat, lon, wantBuildings) {
    var k = tileKey(lat, lon), box = tileBox(lat, lon), t = tiles[k], now = Date.now();

    if (!(t && t.at && (now - t.at) < STALE_MS) && !asking['r' + k] && !blocked('r' + k)) {
      asking['r' + k] = 1;
      enqueue(function () { return fetchPart(k, box, 'roads'); }, true);
    }
    if (wantBuildings &&
        !(t && t.bldAt && (now - t.bldAt) < STALE_MS) &&
        !asking['b' + k] && !blocked('b' + k)) {
      asking['b' + k] = 1;
      enqueue(function () { return fetchPart(k, box, 'bld'); }, false);
    }
  }

  /* How long to wait before asking again. Overpass says when a slot frees
     up, but a cross-origin reader cannot see the header unless the server
     exposes it, so there is a sane default behind it. */
  function retryAfter(r) {
    var h = 0;
    try { h = parseFloat(r.headers.get('Retry-After') || '') * 1000; } catch (e) { h = 0; }
    if (!isFinite(h) || h <= 0) h = 12000;
    return Math.max(3000, Math.min(30000, h));
  }

  function fetchPart(k, box, kind) {
    var bb = box[0].toFixed(5) + ',' + box[1].toFixed(5) + ',' +
             box[2].toFixed(5) + ',' + box[3].toFixed(5);
    var roads = kind === 'roads';
    var q = roads
      ? '[out:json][timeout:25];way["highway"~"^(' + Object.keys(CLASS).join('|') + ')$"](' + bb + ');out geom;'
      : '[out:json][timeout:40];way["building"](' + bb + ');out geom;';
    var id = (roads ? 'r' : 'b') + k;

    return attempt(0, false);

    function attempt(i, retried) {
      if (i >= ENDPOINTS.length) {
        delete asking[id];
        failedAt[id] = Date.now();
        emit();
        return Promise.resolve();
      }
      return U.fetchT(ENDPOINTS[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
      }, roads ? 22000 : 40000).then(function (r) {
        /* BUSY IS NOT BROKEN. 429 is every slot taken, 504 is the query
           timing out under load. Both mean try again shortly; neither
           means there are no roads here. */
        if (r.status === 429 || r.status === 504) {
          if (retried) return attempt(i + 1, false);
          return wait(retryAfter(r)).then(function () { return attempt(i, true); });
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().then(function (j) {
          take(k, kind, j);
          delete asking[id];
        });
      }).catch(function () { return attempt(i + 1, retried); });
    }
  }

  /* Fold one answer into the tile, leaving the other half alone. */
  function take(k, kind, j) {
    var t = tiles[k] || { at: 0, ways: [], bld: [], bldAt: 0 };
    var ways = [], bld = [];
    (j.elements || []).forEach(function (el) {
      if (!el.geometry || el.geometry.length < 2) return;
      var tags = el.tags || {};
      /* Five decimals is about a metre - far finer than the map draws,
         and it keeps the stored copy small. */
      var pts = el.geometry.map(function (g) { return [+g.lat.toFixed(5), +g.lon.toFixed(5)]; });

      if (tags.building) {
        if (pts.length < 4) return;               // not a closed footprint
        bld.push({ h: heightOf(tags), n: tags.name || '', pts: simplify(pts) });
        return;
      }
      ways.push({ k: tags.highway || 'residential', n: tags.name || '', pts: pts });
    });

    if (kind === 'roads') { t.ways = ways; t.at = Date.now(); }
    else { t.bld = bld; t.bldAt = Date.now(); if (!t.at) t.at = Date.now(); }
    tiles[k] = t;
    save();
    emit();
  }

  /* Every way within reach of a point, from whatever tiles are held. */
  function near() {
    var out = [];
    Object.keys(tiles).forEach(function (k) {
      var t = tiles[k];
      if (!t || !t.ways) return;
      out = out.concat(t.ways);
    });
    return out;
  }

  /* How tall to draw it. OpenStreetMap gives an explicit height on some
     buildings and a storey count on more of them; where it gives neither,
     a low default is better than a guess that makes a bungalow a tower. */
  function heightOf(tags) {
    var h = parseFloat(tags.height || tags['building:height'] || '');
    if (isFinite(h) && h > 0 && h < 400) return h;
    var lv = parseFloat(tags['building:levels'] || tags.levels || '');
    if (isFinite(lv) && lv > 0 && lv < 130) return lv * 3.1 + 1;
    return 7;
  }

  /* A footprint traced from aerial imagery can carry a hundred points for a
     rectangle. Anything within half a metre of the line between its
     neighbours is dropped - invisible at map scale, and it is the
     difference between a tile that fits on the device and one that does
     not. */
  function simplify(pts) {
    if (pts.length < 6) return pts;
    var out = [pts[0]];
    for (var i = 1; i < pts.length - 1; i++) {
      var a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      var ax = (a[1] - c[1]) * 74000, ay = (a[0] - c[0]) * 111320;
      var bx = (b[1] - c[1]) * 74000, by = (b[0] - c[0]) * 111320;
      var cross = Math.abs(ax * by - ay * bx);
      var len = Math.sqrt(ax * ax + ay * ay) || 1;
      if (cross / len > 0.5) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /* Every building held, with its footprint. */
  function buildings() {
    var out = [];
    Object.keys(tiles).forEach(function (k) {
      if (tiles[k] && tiles[k].bld) out = out.concat(tiles[k].bld);
    });
    return out;
  }

  function width(cls) { return CLASS[cls] || 2; }
  function have() { return Object.keys(tiles).length; }
  function busy() { return Object.keys(asking).length > 0; }
  /* What is still coming, so the map can say "streets" or "buildings"
     rather than leaving the reader looking at an empty square. */
  function pending() {
    var r = 0, b = 0;
    Object.keys(asking).forEach(function (id) { if (id.charAt(0) === 'r') r++; else b++; });
    return { roads: r, buildings: b, queued: queue.length };
  }

  load();

  return { ensure: ensure, near: near, buildings: buildings, width: width, on: on, have: have, busy: busy,
           pending: pending, _tiles: function () { return tiles; } };
})();
