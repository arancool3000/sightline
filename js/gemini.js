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

  /* WHAT COUNTS AS A KEY.

     "gemini keys are sometimes AQ. and not AIza so sightline declines
      them."

     It used to require the AIza prefix - a guess about Google's issuing
     format, written into our code, and Google issues others. A guess that
     refuses a real key is worse than no check at all: the reader has a
     working key in their hand and an app telling them it is wrong.

     The only judge of whether a key WORKS is the server. This asks the
     smaller question - is there something here that could be one, rather
     than a pasted URL, a sentence, or half of one. */
  function looksLikeKey(k) {
    k = String(k || '').trim();
    if (k.length < 20 || k.length > 200) return false;
    if (/\s/.test(k)) return false;                  // a sentence, or a bad paste
    if (k.indexOf('/') >= 0 || k.indexOf('\\') >= 0) return false;   // a URL, not a key
    return /^[A-Za-z0-9_.\-]+$/.test(k);
  }
  function has() { return looksLikeKey(key()); }

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

  /* ---- SPEAKING THE ANSWER ----

     "i want tts for the Ai, using gemini api tts when it has not hit
      limit and using on device tts ... "

     Gemini's speech models answer with raw 16-bit PCM at 24 kHz. Same key,
     same turned-away rule, same cooldown as the text models, so a quota
     hit on one is a quota hit on both and the voice drops to the device
     for a while rather than hammering. Answers { ok, pcm: Int16Array,
     rate } or { ok:false, error }. The model list is tried in order,
     because the speech model names have moved twice in a year. */
  var TTS_MODELS = ['gemini-3.5-flash-tts', 'gemini-2.5-flash-preview-tts'];
  var ttsBlockedUntil = 0;

  function tts(text, voice) {
    text = String(text || '').slice(0, 600);
    if (!text || !has()) return Promise.resolve({ ok: false, error: 'no key set' });
    if (Date.now() < ttsBlockedUntil) return Promise.resolve({ ok: false, error: 'speech is at its limit', turnedAway: true });
    var payload = {
      contents: [{ role: 'user', parts: [{ text: text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } }
      }
    };
    function attempt(i) {
      if (i >= TTS_MODELS.length) return { ok: false, error: lastError || 'no speech model answered' };
      return call(TTS_MODELS[i], payload).then(function (r) {
        if (r.status === 200) {
          var json; try { json = JSON.parse(r.text); } catch (e) { return { ok: false, error: 'unreadable audio' }; }
          var part = null;
          try { part = (json.candidates[0].content.parts || []).filter(function (p) { return p.inlineData || p.inline_data; })[0]; } catch (e) {}
          var d = part && (part.inlineData || part.inline_data);
          if (!d || !d.data) return { ok: false, error: 'no audio in the answer' };
          var rate = 24000, m = /rate=(\d+)/.exec(d.mimeType || d.mime_type || '');
          if (m) rate = parseInt(m[1], 10) || 24000;
          var bin = atob(d.data), n = bin.length >> 1, pcm = new Int16Array(n);
          for (var k = 0; k < n; k++) pcm[k] = (bin.charCodeAt(2 * k) | (bin.charCodeAt(2 * k + 1) << 8)) << 16 >> 16;
          return { ok: true, pcm: pcm, rate: rate, model: TTS_MODELS[i] };
        }
        if (r.status === 401 || (r.status === 403 && !/quota|limit/i.test(r.text))) return { ok: false, error: 'the key was refused', keyBad: true };
        if (turnedAway(r.status, r.text)) {
          /* 404 means this name is gone, not that we are over: try the next. */
          if (r.status !== 404 && r.status !== 400) { ttsBlockedUntil = Date.now() + COOLDOWN_MS; lastError = 'speech is at its limit'; return { ok: false, error: lastError, turnedAway: true }; }
          lastError = TTS_MODELS[i] + ' not available';
          return attempt(i + 1);
        }
        lastError = 'HTTP ' + r.status;
        return attempt(i + 1);
      }).catch(function (e) { lastError = String(e && e.message || e).slice(0, 90); return attempt(i + 1); });
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

  return { ask: ask, test: test, tts: tts, state: state, has: has, looksLikeKey: looksLikeKey,
           TTS_MODELS: TTS_MODELS,
           PRIMARY: PRIMARY, FALLBACK: FALLBACK,
           _turnedAway: turnedAway, _reset: function () { blockedUntil = 0; lastError = ''; } };
})();
