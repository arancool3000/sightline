/* Sightline - persisted preferences. */
'use strict';

var SET = (function () {

  var KEY = 'sightline.settings.v1';

  /* The analysis endpoint defaults to the deployed Worker. Leaving it blank
     meant every install ran on-device only, which can only ever produce a
     generic noun - "chair", "printer" - and that is not an answer worth
     showing. Clearing the field still switches the cloud tier off. */
  var DEFAULT_API = 'https://sightline-api.arancool3000.workers.dev';

  var DEFAULTS = {
    apiBase: DEFAULT_API,
    faces: true,
    conf: 0.75,
    pace: 1400,
    capFrom: 'auto',
    capTo: 'en',
    capBoth: true,
    mode: 'all',
    facing: 'environment',
    apiCleared: false,
    /* Only for an endpoint you run yourself - a Pi behind a tunnel needs a
       lock on the door. The Cloudflare Worker does not use one. */
    apiKey: ''
  };

  var state = Object.assign({}, DEFAULTS);

  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var saved = JSON.parse(raw);
      Object.keys(DEFAULTS).forEach(function (k) {
        if (saved[k] !== undefined) state[k] = saved[k];
      });
      /* A device that ran an early build stored apiBase:'' - back when there
         was no default - and that empty string then beat every later
         default, so those installs were stuck on-device for ever, showing
         ENG LOCAL and a generic noun for a 3D printer.

         An empty endpoint is only respected when the user cleared it
         themselves, which is recorded explicitly rather than inferred. */
      if (!state.apiBase && !saved.apiCleared) state.apiBase = DEFAULT_API;
    }
  } catch (e) { /* first run, or storage blocked */ }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  return {
    get: function (k) { return state[k]; },
    set: function (k, v) {
      state[k] = v;
      if (k === 'apiBase') state.apiCleared = !String(v || '').trim();
      save();
    },
    defaultApi: DEFAULT_API,
    all: function () { return state; },
    /* An endpoint is configured and looks like a URL we can actually call. */
    hasApi: function () { return /^https?:\/\/.+/i.test(state.apiBase || ''); },
    api: function (path) { return String(state.apiBase || '').replace(/\/+$/, '') + path; },
    apiHeaders: function () {
      var h = { 'Content-Type': 'application/json' };
      if (state.apiKey) h['X-Sightline-Key'] = state.apiKey;
      return h;
    }
  };
})();
