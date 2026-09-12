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
  var MAX_TILES = 24;           // what is kept on the device
  var STALE_MS = 30 * 86400000; // a month; roads change, but not weekly

  var tiles = {};               // "lat,lon" -> { at, ways:[{ k, pts:[[lat,lon]..] }] }
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
        keys.sort(function (a, b) { return tiles[a].at - tiles[b].at; });
        keys.slice(0, keys.length - MAX_TILES).forEach(function (k) { delete tiles[k]; });
      }
      localStorage.setItem(KEY, JSON.stringify(tiles));
    } catch (e) {
      /* Out of room: keep the newest few and try once more. */
      try {
        var ks = Object.keys(tiles).sort(function (a, b) { return tiles[b].at - tiles[a].at; });
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

  /* Ask for the tile you are standing in, and only that one. */
  function ensure(lat, lon) {
    var k = tileKey(lat, lon);
    var have = tiles[k];
    if (have && (Date.now() - have.at) < STALE_MS) return;
    if (asking[k]) return;
    if (failedAt[k] && (Date.now() - failedAt[k]) < 600000) return;   // ten minutes
    fetchTile(k, tileBox(lat, lon));
  }

  function fetchTile(k, box) {
    asking[k] = 1;
    var q = '[out:json][timeout:20];way["highway"~"^(' +
            Object.keys(CLASS).join('|') + ')$"](' +
            box[0].toFixed(5) + ',' + box[1].toFixed(5) + ',' +
            box[2].toFixed(5) + ',' + box[3].toFixed(5) + ');out geom;';

    tryEndpoint(0);

    function tryEndpoint(i) {
      if (i >= ENDPOINTS.length) {
        delete asking[k];
        failedAt[k] = Date.now();
        return;
      }
      U.fetchT(ENDPOINTS[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
      }, 22000).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        var ways = [];
        (j.elements || []).forEach(function (el) {
          if (!el.geometry || el.geometry.length < 2) return;
          var cls = (el.tags && el.tags.highway) || 'residential';
          ways.push({
            k: cls,
            n: (el.tags && el.tags.name) || '',
            /* Five decimals is about a metre - far finer than the map draws,
               and it keeps the stored copy small. */
            pts: el.geometry.map(function (g) { return [+g.lat.toFixed(5), +g.lon.toFixed(5)]; })
          });
        });
        tiles[k] = { at: Date.now(), ways: ways };
        delete asking[k];
        save();
        emit();
      }).catch(function () { tryEndpoint(i + 1); });
    }
  }

  /* Every way within reach of a point, from whatever tiles are held. */
  function near(lat, lon) {
    var out = [];
    Object.keys(tiles).forEach(function (k) {
      var t = tiles[k];
      if (!t || !t.ways) return;
      out = out.concat(t.ways);
    });
    return out;
  }

  function width(cls) { return CLASS[cls] || 2; }
  function have() { return Object.keys(tiles).length; }
  function busy() { return Object.keys(asking).length > 0; }

  load();

  return { ensure: ensure, near: near, width: width, on: on, have: have, busy: busy,
           _tiles: function () { return tiles; } };
})();
