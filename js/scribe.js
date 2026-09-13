/* scribe.js - the caption track's own ears and its own translator.

   "use these, with fallbacks to mymemory and on device for speech to text
    and translate"

   Two of the Live models on this key are unlimited and do exactly one job
   each: one turns speech into text, the other translates. They are not
   conversation models - they hold no conversation and call no command - so
   LIVE deliberately filters them out of the list it picks an assistant
   from. This module is where they are used instead.

   THE TWO CHAINS, IN ORDER, AND WHY EACH STEP IS THERE:

     hearing    the transcribe model  ->  the browser's own recogniser
     translate  the translate model   ->  Gemini text  ->  MyMemory

   The browser's recogniser is the on-device fallback, and on iOS Safari
   there isn't one at all - which is the whole reason the first step is
   worth having. MyMemory needs no key, so the last step still works for a
   reader who has never entered one; it is rate limited per address, so it
   is last rather than first.

   ⚠ HONEST LIMIT: the translate model is a speech-to-speech model being
   asked for text, and no key was available here to prove it answers that
   way. So it is TRIED with a short deadline and the chain falls through
   quietly when it does not answer - a caption is never held up waiting for
   it, and nothing in the interface claims it is in use unless a line
   really came back from it. via() says which step actually answered. */

var SCRIBE = (function () {
  'use strict';

  var HOST = 'wss://generativelanguage.googleapis.com/ws/' +
             'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  var UP_RATE = 16000;
  var TRY_MS = 3500;          // how long a translate turn may take before we move on
  var IDLE_MS = 120000;       // a translator socket nobody is using closes itself

  /* ---- which model does which job ----

     Picked by what the name says, from the list LIVE already fetched. A
     name that is gone simply is not in the list, so there is no hand list
     of ids here to go stale. */
  function pick(all, want) {
    if (!all || !all.length) return '';
    var hits = all.filter(function (n) { return want.test(n); });
    if (!hits.length) return '';
    /* The biggest version number wins, and a stable name beats a preview. */
    hits.sort(function (a, b) { return score(b) - score(a); });
    return hits[0];
  }
  function score(n) {
    var v = 0, m = /gemini-(\d+(?:\.\d+)?)/.exec(String(n));
    if (m) v = parseFloat(m[1]) * 10;
    if (/preview|exp/.test(n)) v -= 1;
    return v;
  }
  var WANT_HEAR = /transcribe/i;
  var WANT_TRAN = /translate/i;

  function models() {
    var all = (window.LIVE && LIVE.bidiNow) ? LIVE.bidiNow() : null;
    return { hear: pick(all, WANT_HEAR), translate: pick(all, WANT_TRAN) };
  }
  /* Asking costs one request the first time and nothing afterwards. */
  function find() {
    if (!window.LIVE || !LIVE.bidi) return Promise.resolve(models());
    return LIVE.bidi().then(models, models);
  }

  function keyed() { return !!(window.GEM && GEM.has && GEM.has()); }
  function canHear() { return keyed() && !!models().hear; }
  function canTranslate() { return keyed() && !!models().translate; }

  /* ---- the shared audio bits ---- */

  function b64(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function frame(data, done) {
    if (typeof data === 'string') { try { done(JSON.parse(data)); } catch (e) {} return; }
    if (data && data.text) { data.text().then(function (t) { try { done(JSON.parse(t)); } catch (e) {} }); return; }
    if (data instanceof ArrayBuffer) {
      try { done(JSON.parse(new TextDecoder().decode(data))); } catch (e) {}
    }
  }

  /* ---- HEARING -------------------------------------------------------

     A socket on the transcribe model with the microphone streamed into it.
     Only the input transcription is read: this model is not being asked to
     say anything, so nothing comes back to play. */

  var hSock = null, hOpen = false, hStarting = false, hModel = '';
  var ac = null, mic = null, node = null, sink = null, stream = null;
  var onLine = null, onPart = null, onDrop = null;
  var buf = '', lastAt = 0, flushTimer = null;
  var hErr = '';

  function hearing() { return hOpen; }

  /* Start listening. done(text, lang) for a finished sentence, part(text)
     as it grows, gone(reason) when the socket will not carry on - which is
     the signal to fall back to the browser's recogniser. */
  function listen(done, part, gone) {
    if (hOpen || hStarting) return true;
    if (!canHear()) return false;
    onLine = done; onPart = part; onDrop = gone;
    hStarting = true; hErr = '';
    hModel = models().hear;

    var sock;
    try { sock = new WebSocket(HOST + '?key=' + encodeURIComponent(GEM.key())); }
    catch (e) { hStarting = false; hErr = 'socket refused'; return false; }

    var settled = false;
    var giveUp = setTimeout(function () {
      if (settled) return;
      settled = true; hStarting = false; hErr = 'the transcriber did not answer';
      try { sock.close(); } catch (e) {}
      drop(hErr);
    }, 8000);

    sock.onopen = function () {
      sock.send(JSON.stringify({ setup: {
        model: hModel,
        /* TEXT, not audio: we want the words, not a voice reading them. */
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: {}
      } }));
    };

    sock.onmessage = function (m) {
      frame(m.data, function (msg) {
        if (msg.setupComplete) {
          if (settled) return;
          settled = true; clearTimeout(giveUp);
          hSock = sock; hOpen = true; hStarting = false;
          micOn();
          return;
        }
        read(msg);
      });
    };
    sock.onerror = function () { hErr = 'the transcriber connection failed'; };
    sock.onclose = function (e) {
      if (!settled) {
        settled = true; clearTimeout(giveUp); hStarting = false;
        hErr = 'transcriber: ' + ((e && e.code) || 'closed');
        return drop(hErr);
      }
      if (sock !== hSock) return;
      stopHear(true);
      drop(hErr || 'the transcriber closed');
    };
    return true;
  }

  function drop(why) {
    var f = onDrop;
    if (f) { try { f(why); } catch (e) {} }
  }

  /* WHERE A SENTENCE ENDS.

     A transcriber sends words as it hears them and says nothing about
     sentences, so the end of one is a gap in the talking - the same rule a
     person uses. The growing text goes out as a partial straight away, and
     a pause of PAUSE_MS with nothing new closes the line. */
  var PAUSE_MS = 900;

  function read(msg) {
    var sc = msg && msg.serverContent;
    if (!sc) return;
    var t = sc.inputTranscription && sc.inputTranscription.text;
    if (t) {
      buf += t; lastAt = Date.now();
      if (onPart) { try { onPart(buf.trim()); } catch (e) {} }
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, PAUSE_MS);
    }
    /* The model's own turn ending is a harder end than any gap. */
    if (sc.turnComplete) flush();
  }

  function flush() {
    clearTimeout(flushTimer);
    var text = buf.trim();
    buf = '';
    if (!text) return;
    if (onLine) { try { onLine(text, ''); } catch (e) {} }
  }

  function micOn() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { hErr = 'no audio in this browser'; return stopHear(); }
    if (!ac) { try { ac = new AC(); } catch (e) { hErr = 'no audio'; return stopHear(); } }
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }

    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (s) {
        if (!hOpen) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s;
        mic = ac.createMediaStreamSource(s);
        node = ac.createScriptProcessor(4096, 1, 1);
        var ratio = ac.sampleRate / UP_RATE;
        node.onaudioprocess = function (e) {
          if (!hOpen || !hSock || hSock.readyState !== 1) return;
          var input = e.inputBuffer.getChannelData(0);
          var out = new Int16Array(Math.floor(input.length / ratio));
          for (var i = 0; i < out.length; i++) {
            var v = input[Math.floor(i * ratio)];
            out[i] = Math.max(-1, Math.min(1, v)) * 32767;
          }
          try {
            hSock.send(JSON.stringify({ realtimeInput: {
              audio: { mimeType: 'audio/pcm;rate=' + UP_RATE, data: b64(out.buffer) }
            } }));
          } catch (err) {}
        };
        mic.connect(node);
        /* ⚠ A silent sink, never ac.destination - the microphone reaching
           the speaker is a feedback loop the echo canceller then clamps,
           which is what took the sound out of the assistant once already. */
        sink = ac.createGain(); sink.gain.value = 0;
        node.connect(sink); sink.connect(ac.destination);
      }, function () { hErr = 'the microphone was refused'; stopHear(); drop(hErr); });
  }

  function stopHear(keepSock) {
    hOpen = false; hStarting = false;
    clearTimeout(flushTimer);
    buf = '';
    try { if (node) node.disconnect(); } catch (e) {}
    try { if (mic) mic.disconnect(); } catch (e) {}
    try { if (sink) sink.disconnect(); } catch (e) {}
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    node = mic = sink = stream = null;
    if (!keepSock) { try { if (hSock) hSock.close(); } catch (e) {} }
    hSock = null;
  }

  /* ---- TRANSLATING ---------------------------------------------------

     One socket, kept open between lines, with each line sent as a turn and
     the reply read back as text. Requests are queued: a Live socket
     answers one turn at a time, and two overlapping turns come back
     interleaved with no way to tell which half belongs to which line. */

  var tSock = null, tOpen = false, tStarting = false, tModel = '';
  var queue = [], live = null, tIdle = null, tDead = false;
  var lastVia = '';

  function via() { return lastVia; }

  function openT() {
    if (tOpen || tStarting || tDead) return;
    if (!canTranslate()) { tDead = true; return; }
    tStarting = true;
    tModel = models().translate;
    var sock;
    try { sock = new WebSocket(HOST + '?key=' + encodeURIComponent(GEM.key())); }
    catch (e) { tStarting = false; tDead = true; return failAll(); }

    var settled = false;
    var giveUp = setTimeout(function () {
      if (settled) return;
      settled = true; tStarting = false; tDead = true;
      try { sock.close(); } catch (e) {}
      failAll();
    }, 8000);

    sock.onopen = function () {
      sock.send(JSON.stringify({ setup: {
        model: tModel,
        generationConfig: { responseModalities: ['TEXT'] }
      } }));
    };
    sock.onmessage = function (m) {
      frame(m.data, function (msg) {
        if (msg.setupComplete) {
          if (settled) return;
          settled = true; clearTimeout(giveUp);
          tSock = sock; tOpen = true; tStarting = false;
          pump();
          return;
        }
        gather(msg);
      });
    };
    sock.onerror = function () {};
    sock.onclose = function () {
      if (!settled) {
        settled = true; clearTimeout(giveUp); tStarting = false;
        /* It refused the shape of the request, and it will refuse the next
           one the same way. Stop asking for the rest of the session rather
           than opening a socket per caption line. */
        tDead = true;
        return failAll();
      }
      if (sock !== tSock) return;
      tOpen = false; tSock = null;
      failAll();
    };
  }

  function gather(msg) {
    if (!live) return;
    var sc = msg && msg.serverContent;
    if (!sc) return;
    var parts = (sc.modelTurn && sc.modelTurn.parts) || [];
    parts.forEach(function (p) { if (p && p.text) live.got += p.text; });
    if (sc.turnComplete) settle(live.got.trim());
  }

  function settle(text) {
    if (!live) return;
    var job = live; live = null;
    clearTimeout(job.timer);
    /* A translator that hands back the words it was given has not
       translated anything; that is the original, not an answer. */
    if (text && text.trim() !== job.text.trim()) { lastVia = 'live'; job.res(text); }
    else job.res('');
    idle();
    pump();
  }

  function failAll() {
    if (live) { var j = live; live = null; clearTimeout(j.timer); j.res(''); }
    queue.splice(0).forEach(function (j) { j.res(''); });
  }

  function idle() {
    clearTimeout(tIdle);
    tIdle = setTimeout(function () {
      if (live || queue.length) return idle();
      try { if (tSock) tSock.close(); } catch (e) {}
      tSock = null; tOpen = false;
    }, IDLE_MS);
  }

  function pump() {
    if (live || !queue.length) return;
    if (!tOpen) return openT();
    var job = queue.shift();
    live = job; job.got = '';
    try {
      tSock.send(JSON.stringify({ clientContent: {
        turns: [{ role: 'user', parts: [{ text: ask(job) }] }],
        turnComplete: true
      } }));
    } catch (e) { return settle(''); }
    job.timer = setTimeout(function () { settle(''); }, TRY_MS);
    idle();
  }

  function ask(job) {
    return 'Translate into ' + name(job.to) + '. Reply with the translation only, ' +
           'no quotes and no explanation.\n\n' + job.text;
  }

  var NAMES = { en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian',
                pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', tr: 'Turkish',
                ar: 'Arabic', hi: 'Hindi', ur: 'Urdu', fa: 'Persian', zh: 'Chinese',
                ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', th: 'Thai', id: 'Indonesian',
                sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', cs: 'Czech',
                el: 'Greek', he: 'Hebrew', uk: 'Ukrainian', ro: 'Romanian', hu: 'Hungarian' };
  function name(code) {
    var k = String(code || '').split('-')[0].toLowerCase();
    return NAMES[k] || k || 'English';
  }

  /* The Live translator, as a promise that answers '' rather than throwing
     when it cannot help - so a caller can treat it as one step of a chain
     instead of wrapping it. */
  function liveTranslate(text, from, to) {
    if (!text || !to || !canTranslate() || tDead) return Promise.resolve('');
    return new Promise(function (res) {
      queue.push({ text: text, from: from, to: to, res: res, got: '', timer: null });
      while (queue.length > 6) { var d = queue.shift(); d.res(''); }
      pump();
    });
  }

  /* ---- MYMEMORY, THE KEYLESS LAST STEP -------------------------------

     No key, no account, and it answers for a reader who has never entered
     one - which is the only step in this chain that is true of everybody.
     It is rate limited per address, so it is the last thing tried and
     never the first. */
  var MM = 'https://api.mymemory.translated.net/get';

  function myMemory(text, from, to) {
    if (!text || !to || from === to) return Promise.resolve('');
    /* Its own limit is per request, and a caption line is never long. */
    if (text.length > 480) text = text.slice(0, 480);
    var url = MM + '?q=' + encodeURIComponent(text) +
              '&langpair=' + encodeURIComponent((from || 'en') + '|' + to);
    var get = (window.U && U.fetchT) ? U.fetchT(url, {}, 7000) : fetch(url);
    return get.then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var out = j && j.responseData && j.responseData.translatedText;
        if (!out) return '';
        /* It answers with a complaint in the translation field when it is
           out of quota or given a pair it does not have. That is not a
           translation and must not be put on screen as one. */
        if (/^(MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID|NO QUERY)/i.test(out)) return '';
        if (j.responseStatus && Number(j.responseStatus) >= 400) return '';
        lastVia = 'mymemory';
        return out;
      })
      .catch(function () { return ''; });
  }

  /* ---- THE WHOLE CHAIN ----

     Each step answers '' when it cannot help, so the chain is a list and
     not a tree. The caller gets the first real answer and the name of the
     step that gave it. */
  function translate(text, from, to) {
    lastVia = '';
    if (!text || !to || from === to) return Promise.resolve({ ok: false, text: '', via: '' });
    return liveTranslate(text, from, to).then(function (out) {
      if (out) return { ok: true, text: out, via: 'live' };
      var gem = (window.GEM && GEM.has && GEM.has())
        ? GEM.translate(text, from, to).then(function (r) { return (r && r.ok) ? r.text : ''; },
                        function () { return ''; })
        : Promise.resolve('');
      return gem.then(function (g) {
        if (g) { lastVia = 'gemini'; return { ok: true, text: g, via: 'gemini' }; }
        return myMemory(text, from, to).then(function (mm) {
          return mm ? { ok: true, text: mm, via: 'mymemory' } : { ok: false, text: '', via: '' };
        });
      });
    });
  }

  function health() {
    var m = models();
    return { hearModel: m.hear, translateModel: m.translate,
             hearing: hOpen, translateOpen: tOpen, translateDead: tDead,
             note: hErr, via: lastVia, queued: queue.length };
  }

  return { models: models, find: find, canHear: canHear, canTranslate: canTranslate,
           listen: listen, stop: stopHear, hearing: hearing,
           translate: translate, via: via, health: health,
           _live: liveTranslate, _myMemory: myMemory, _pick: pick, _flush: flush,
           _feed: read };
})();
