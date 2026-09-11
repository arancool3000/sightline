/* Sightline - persisted preferences. */
'use strict';

var SET = (function () {

  var KEY = 'sightline.settings.v1';

  var DEFAULTS = {
    apiBase: '',
    faces: true,
    conf: 0.75,
    pace: 1400,
    capFrom: 'auto',
    capTo: 'en',
    capBoth: true,
    mode: 'all',
    facing: 'environment'
  };

  var state = Object.assign({}, DEFAULTS);

  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var saved = JSON.parse(raw);
      Object.keys(DEFAULTS).forEach(function (k) {
        if (saved[k] !== undefined) state[k] = saved[k];
      });
    }
  } catch (e) { /* first run, or storage blocked */ }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  return {
    get: function (k) { return state[k]; },
    set: function (k, v) { state[k] = v; save(); },
    all: function () { return state; },
    /* An endpoint is configured and looks like a URL we can actually call. */
    hasApi: function () { return /^https?:\/\/.+/i.test(state.apiBase || ''); },
    api: function (path) { return String(state.apiBase || '').replace(/\/+$/, '') + path; }
  };
})();
