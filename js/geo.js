/* Sightline - where you are, and what is around you.

   Everything here is keyless and stays keyless. There is no map-tile
   provider, no geocoder and no weather account:

     position   the device's own GPS, through navigator.geolocation
     heading    the device's own compass, through deviceorientation
     places     Wikipedia's geosearch - no key, CORS-open, and the same
                articles the dossier already links to
     weather    Open-Meteo - no key, no sign-up, CORS-open

   Nothing is uploaded. The coordinates are sent to Wikipedia and Open-Meteo
   only, rounded, and only to ask what is nearby; they are never stored. */
'use strict';

var GEO = (function () {

  var pos = null;            // { lat, lon, acc }
  var heading = null;        // degrees from north, or null if there is no compass
  var places = [];           // [{ title, lat, lon, dist, bearing }]
  var weather = null;        // { temp, code, wind }
  var err = '';
  var watchId = 0;
  var fetchedAt = 0, fetchedNear = null, busy = false;
  var listeners = [];

  var NEAR_RADIUS = 3000;    // metres
  var REFETCH_MS = 240000;   // and whenever you have moved 250 m
  var REFETCH_M = 250;

  function on(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(function (f) { try { f(state()); } catch (e) {} }); }

  /* Great-circle distance in metres. */
  function metres(a, b) {
    var R = 6371000, p = Math.PI / 180;
    var dLat = (b.lat - a.lat) * p, dLon = (b.lon - a.lon) * p;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /* Initial bearing from a to b, degrees clockwise from north. */
  function bearing(a, b) {
    var p = Math.PI / 180;
    var y = Math.sin((b.lon - a.lon) * p) * Math.cos(b.lat * p);
    var x = Math.cos(a.lat * p) * Math.sin(b.lat * p) -
            Math.sin(a.lat * p) * Math.cos(b.lat * p) * Math.cos((b.lon - a.lon) * p);
    return (Math.atan2(y, x) / p + 360) % 360;
  }

  function start() {
    if (!navigator.geolocation) { err = 'this device has no location'; emit(); return; }
    if (watchId) return;
    watchId = navigator.geolocation.watchPosition(function (p) {
      err = '';
      pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0) };
      if (typeof p.coords.heading === 'number' && !isNaN(p.coords.heading) && p.coords.speed > 0.7) {
        heading = p.coords.heading;              // moving: GPS course beats the compass
      }
      maybeRefresh();
      emit();
    }, function (e) {
      err = e && e.code === 1 ? 'location permission refused'
          : e && e.code === 3 ? 'location timed out'
          : 'location unavailable';
      emit();
    }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });

    /* iOS needs a user gesture to grant the compass; that is asked for by
       the map panel, not here, so the rest still works without it. */
    listenCompass();
  }

  function listenCompass() {
    function handle(e) {
      var h = null;
      if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;   // iOS, already true north
      else if (typeof e.alpha === 'number') h = e.absolute === false ? null : (360 - e.alpha) % 360;
      if (h !== null && !isNaN(h)) { heading = h; }
    }
    window.addEventListener('deviceorientationabsolute', handle, true);
    window.addEventListener('deviceorientation', handle, true);
  }

  /* iOS 13+ will not deliver orientation events without an explicit grant,
     and the grant must come from a tap. */
  function askCompass() {
    var D = window.DeviceOrientationEvent;
    if (!D || typeof D.requestPermission !== 'function') return Promise.resolve(true);
    return D.requestPermission().then(function (r) { return r === 'granted'; }).catch(function () { return false; });
  }

  function maybeRefresh() {
    if (!pos || busy) return;
    var moved = fetchedNear ? metres(fetchedNear, pos) : Infinity;
    if (moved < REFETCH_M && (Date.now() - fetchedAt) < REFETCH_MS) return;
    refresh();
  }

  function refresh() {
    if (!pos || busy) return Promise.resolve();
    busy = true;
    var here = { lat: pos.lat, lon: pos.lon };
    fetchedNear = here; fetchedAt = Date.now();
    return Promise.all([nearby(here), forecast(here)]).then(function () {
      busy = false; emit();
    }).catch(function () { busy = false; emit(); });
  }

  /* Wikipedia's own geosearch. No key, and it answers with the article
     titles the dossier can already open. */
  function nearby(here) {
    var u = 'https://en.wikipedia.org/w/api.php?action=query&list=geosearch' +
            '&gscoord=' + here.lat.toFixed(5) + '%7C' + here.lon.toFixed(5) +
            '&gsradius=' + NEAR_RADIUS + '&gslimit=30&format=json&origin=*';
    return fetch(u).then(function (r) { return r.json(); }).then(function (j) {
      var list = (j && j.query && j.query.geosearch) || [];
      places = list.map(function (p) {
        var at = { lat: p.lat, lon: p.lon };
        return { title: p.title, lat: p.lat, lon: p.lon,
                 dist: Math.round(metres(here, at)), bearing: bearing(here, at) };
      }).sort(function (a, b) { return a.dist - b.dist; });
    }).catch(function () { /* offline is not an error worth showing */ });
  }

  function forecast(here) {
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + here.lat.toFixed(3) +
            '&longitude=' + here.lon.toFixed(3) +
            '&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto';
    return fetch(u).then(function (r) { return r.json(); }).then(function (j) {
      var c = j && j.current;
      if (!c) return;
      weather = { temp: Math.round(c.temperature_2m), code: c.weather_code, wind: Math.round(c.wind_speed_10m) };
    }).catch(function () {});
  }

  /* WMO weather codes, in words. */
  var WMO = {
    0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain',
    65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow',
    73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Showers', 81: 'Showers',
    82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail'
  };
  function sky() { return weather ? (WMO[weather.code] || 'Unknown') : ''; }

  /* The nearest named place is the most useful single word on the screen. */
  function locality() { return places.length ? places[0].title : ''; }

  function state() {
    return { pos: pos, heading: heading, places: places, weather: weather,
             sky: sky(), locality: locality(), error: err, ready: !!pos };
  }

  function stop() {
    if (watchId && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = 0;
  }

  return { start: start, stop: stop, state: state, refresh: refresh, on: on,
           askCompass: askCompass, metres: metres, bearing: bearing, sky: sky,
           _set: function (p, h, pl, wx) { pos = p; heading = h; if (pl) places = pl;
                                          if (wx) weather = wx; emit(); } };
})();
