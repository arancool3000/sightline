/* Sightline - asking Gemini directly, with the owner's own key.

   The Worker is still the default and needs no key at all. This is the
   other way: paste a key from ai.google.dev and the app talks to Google
   from the device, which is what makes the voice assistant quick enough to
   hold a conversation with.

   THE KEY STAYS ON THE DEVICE. It is kept in this browser's storage and
   sent to generativelanguage.googleapis.com and nowhere else - not to this
   app's own Worker, not anywhere. A key in a browser is visible to anyone
   holding the phone, which is why it is the owner's own key for their own
   device and the settings page says so.

   TWO MODELS, AND A REASON FOR THE ORDER. Flash Lite 3.5 answers first
   because it is the quicker and cheaper of the two. When it comes back rate
   limited or out of quota, 3.1 takes over - and the app REMEMBERS that for
   a while rather than walking into the same wall on every question.       */
'use strict';

var GEM = (function () {

  var BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var PRIMARY = 'gemini-3.5-flash-lite';
  var FALLBACK = 'gemini-3.1-flash-lite';

  /* How long to stay on the fallback after the first one turns us away.
     Long enough not to retry constantly, short enough to go back when the
     window rolls over. */
  var COOLDOWN_MS = 15 * 60 * 1000;
  var blockedUntil = 0;
  var lastModel = '';
  var lastError = '';

  function key() { return SET.get('geminiKey') || ''; }
  function has() { return /^AIza[\w-]{20,}$/.test(key()); }

  function state() {
    return { hasKey: has(), primary: PRIMARY, fallback: FALLBACK,
             using: onFallback() ? FALLBACK : PRIMARY,
             onFallback: onFallback(),
             backFor: onFallback() ? Math.round((blockedUntil - Date.now()) / 1000) : 0,
             lastModel: lastModel, error: lastError };
  }
  function onFallback() { return Date.now() < blockedUntil; }

  /* Rate limit, quota, or the model simply not being available to this key.
     All three mean "ask the other one", and none of them means the key is
     wrong - which is a different message and worth telling apart. */
  function turnedAway(status, body) {
    if (status === 429) return true;
    if (status === 404 || status === 400) return /not found|not supported|unsupported/i.test(body || '');
    if (status === 403) return /quota|exhaust|limit/i.test(body || '');
    return false;
  }

  function call(model, payload) {
    return U.fetchT(BASE + model + ':generateContent?key=' + encodeURIComponent(key()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 25000).then(function (r) {
      return r.text().then(function (text) { return { status: r.status, text: text }; });
    });
  }

  function textOf(json) {
    try {
      var parts = json.candidates[0].content.parts || [];
      return parts.map(function (p) { return p.text || ''; }).join('').trim();
    } catch (e) { return ''; }
  }

  /* Ask a question, optionally about a picture.

     `image` is a data URL; `want` is 'text' or 'json'. Answers
     { ok, text, json, model } or { ok:false, error }. */
  function ask(prompt, image, opts) {
    opts = opts || {};
    if (!has()) return Promise.resolve({ ok: false, error: 'no key set' });

    var parts = [{ text: prompt }];
    if (image) {
      var comma = image.indexOf(',');
      parts.push({ inline_data: { mime_type: 'image/jpeg',
                                  data: comma === -1 ? image : image.slice(comma + 1) } });
    }
    var payload = {
      contents: [{ role: 'user', parts: parts }],
      generationConfig: {
        temperature: opts.temperature === undefined ? 0.2 : opts.temperature,
        maxOutputTokens: opts.maxTokens || 600
      }
    };
    if (opts.json) payload.generationConfig.responseMimeType = 'application/json';

    var order = onFallback() ? [FALLBACK, PRIMARY] : [PRIMARY, FALLBACK];

    function attempt(i) {
      if (i >= order.length) {
        return { ok: false, error: lastError || 'no model would answer' };
      }
      var model = order[i];
      return call(model, payload).then(function (r) {
        if (r.status === 200) {
          var json;
          try { json = JSON.parse(r.text); } catch (e) { return { ok: false, error: 'unreadable answer' }; }
          lastModel = model;
          lastError = '';
          /* Back on the quick one: stop avoiding it. */
          if (model === PRIMARY) blockedUntil = 0;
          var out = textOf(json);
          var parsed = null;
          if (opts.json) { try { parsed = JSON.parse(out); } catch (e) {} }
          return { ok: true, text: out, json: parsed, model: model };
        }
        if (r.status === 401 || (r.status === 403 && !/quota|limit/i.test(r.text))) {
          lastError = 'the key was refused';
          return { ok: false, error: lastError, keyBad: true };
        }
        if (turnedAway(r.status, r.text)) {
          if (model === PRIMARY) blockedUntil = Date.now() + COOLDOWN_MS;
          lastError = model + ' is at its limit';
          return attempt(i + 1);
        }
        lastError = 'HTTP ' + r.status;
        return attempt(i + 1);
      }).catch(function (e) {
        lastError = String(e && e.message || e).slice(0, 90);
        return attempt(i + 1);
      });
    }

    return Promise.resolve(attempt(0));
  }

  /* A quick check that a pasted key works, without spending a picture. */
  function test() {
    if (!has()) return Promise.resolve({ ok: false, error: 'that does not look like a key' });
    return ask('Reply with the single word: ready', null, { maxTokens: 10, temperature: 0 })
      .then(function (r) {
        return r.ok ? { ok: true, model: r.model, said: r.text }
                    : { ok: false, error: r.error };
      });
  }

  return { ask: ask, test: test, state: state, has: has,
           PRIMARY: PRIMARY, FALLBACK: FALLBACK,
           _turnedAway: turnedAway, _reset: function () { blockedUntil = 0; lastError = ''; } };
})();
