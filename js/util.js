/* Sightline - small shared helpers. No dependencies. */
'use strict';

var U = (function () {

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  /* Escape for safe innerHTML use. Every string that comes from a model,
     an API or a user goes through this before it reaches the DOM. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* Intersection-over-union of two [x,y,w,h] boxes. */
  function iou(a, b) {
    var x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    var x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    var w = x2 - x1, h = y2 - y1;
    if (w <= 0 || h <= 0) return 0;
    var inter = w * h;
    return inter / (a[2] * a[3] + b[2] * b[3] - inter);
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  /* fetch with a timeout that actually aborts the request. */
  function fetchT(url, opts, ms) {
    opts = opts || {};
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, ms || 12000);
    opts.signal = ctl.signal;
    return fetch(url, opts).then(function (r) {
      clearTimeout(timer);
      return r;
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function jget(url, ms) {
    return fetchT(url, { headers: { 'Accept': 'application/json' } }, ms).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* A tiny LRU that also survives a reload via sessionStorage. */
  function Cache(name, max) {
    var map = new Map();
    try {
      var raw = sessionStorage.getItem('sl_' + name);
      if (raw) JSON.parse(raw).forEach(function (kv) { map.set(kv[0], kv[1]); });
    } catch (e) { /* private mode, or quota - the cache is optional */ }
    function persist() {
      try { sessionStorage.setItem('sl_' + name, JSON.stringify(Array.from(map.entries()))); }
      catch (e) { /* ignore */ }
    }
    return {
      get: function (k) {
        if (!map.has(k)) return null;
        var v = map.get(k);
        map.delete(k); map.set(k, v);   // refresh recency
        return v;
      },
      set: function (k, v) {
        if (map.has(k)) map.delete(k);
        map.set(k, v);
        while (map.size > (max || 120)) map.delete(map.keys().next().value);
        persist();
      },
      has: function (k) { return map.has(k); }
    };
  }

  function titleCase(s) {
    return String(s || '').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  return { $: $, $$: $$, el: el, esc: esc, clamp: clamp, iou: iou, lerp: lerp,
           toast: toast, fetchT: fetchT, jget: jget, Cache: Cache, titleCase: titleCase };
})();
