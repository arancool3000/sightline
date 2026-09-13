/* Sightline - live captions and live translation.

   Recognition is the browser's own Web Speech API: free, no key, and the
   audio never leaves the device on engines that run locally. Translation of
   each finished line goes through the worker.

   Note on "auto": Web Speech has to be told which language to listen for -
   it cannot detect one. "Auto" therefore means the device language, and the
   UI says so rather than pretending otherwise. */
'use strict';

var CAPS = (function () {

  var LANGS = [
    ['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['es-ES', 'Spanish'],
    ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'],
    ['pt-BR', 'Portuguese'], ['nl-NL', 'Dutch'], ['pl-PL', 'Polish'],
    ['ru-RU', 'Russian'], ['tr-TR', 'Turkish'], ['ar-SA', 'Arabic'],
    ['hi-IN', 'Hindi'], ['ur-PK', 'Urdu'], ['bn-BD', 'Bengali'],
    ['fa-IR', 'Persian'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'],
    ['zh-CN', 'Chinese (Mandarin)'], ['yue-Hant-HK', 'Chinese (Cantonese)'],
    ['sv-SE', 'Swedish'], ['da-DK', 'Danish'], ['nb-NO', 'Norwegian'],
    ['fi-FI', 'Finnish'], ['cs-CZ', 'Czech'], ['el-GR', 'Greek'],
    ['he-IL', 'Hebrew'], ['th-TH', 'Thai'], ['vi-VN', 'Vietnamese'],
    ['id-ID', 'Indonesian'], ['ms-MY', 'Malay'], ['uk-UA', 'Ukrainian'],
    ['ro-RO', 'Romanian'], ['hu-HU', 'Hungarian']
  ];

  /* Targets are plain two-letter codes - what the translator wants. */
  var TARGETS = [
    ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
    ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'],
    ['ru', 'Russian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'],
    ['ur', 'Urdu'], ['bn', 'Bengali'], ['fa', 'Persian'], ['ja', 'Japanese'],
    ['ko', 'Korean'], ['zh', 'Chinese'], ['sv', 'Swedish'], ['da', 'Danish'],
    ['no', 'Norwegian'], ['fi', 'Finnish'], ['cs', 'Czech'], ['el', 'Greek'],
    ['he', 'Hebrew'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
    ['ms', 'Malay'], ['uk', 'Ukrainian'], ['ro', 'Romanian'], ['hu', 'Hungarian']
  ];

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, on = false, wantOn = false;
  var lines = [];              // recent finished lines, newest last
  var interim = '';
  var tcache = U.Cache('tr', 200);
  var restartTimer = null;
  /* WHY A WATCHDOG.

     Reported as "they either work or fail, mostly fail". Every failure path
     here was silent: 'network' and 'no-speech' returned and waited for
     onend to respin - and when the engine dies without firing onend, which
     Safari does, nothing ever restarted and the bar simply sat there. There
     was no way to tell a quiet room from a dead recogniser.

     So: nothing fails silently any more, and a recogniser that has gone
     quiet without saying so is restarted on a timer rather than trusted. */
  var lastSign = 0;          // when the engine last showed any sign of life
  var watchdog = null;
  var netFails = 0;
  var WATCH_MS = 9000;
  var lastNote = '';

  function sign() { lastSign = Date.now(); }

  function note(txt) {
    lastNote = txt;
    if (window.UI && UI.captionNote) UI.captionNote(txt);
  }

  function watch() {
    clearInterval(watchdog);
    watchdog = setInterval(function () {
      if (!wantOn) { clearInterval(watchdog); watchdog = null; return; }
      if (Date.now() - lastSign < WATCH_MS) return;
      /* No results, no end event, no error: the engine is gone. */
      note('RESTARTING');
      sign();
      try { if (rec) rec.abort(); } catch (e) {}
      on = false;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(spin, 250);
    }, 2000);
  }

  function supported() { return !!SR; }

  /* ---- which language is being spoken --------------------------------

     Web Speech cannot detect a language; it listens for ONE and returns its
     best attempt in that language. So "auto" meant the device language, and
     a French speaker got English phonetic mush that no translator could
     rescue.

     Two halves, and both are needed.

     One: read the SCRIPT and the common words of whatever text comes back,
     which is enough to know what to translate FROM. Entirely on-device.

     Two: when the engine keeps reporting low confidence, it is probably
     listening for the wrong language. Rotate through a short list of
     candidates and keep the one that scores best - an auto language lock.  */

  var SCRIPT = [
    [/[\u0600-\u06ff]/, 'ar'], [/[\u0400-\u04ff]/, 'ru'], [/[\u0370-\u03ff]/, 'el'],
    [/[\u0590-\u05ff]/, 'he'], [/[\u0900-\u097f]/, 'hi'], [/[\u0e00-\u0e7f]/, 'th'],
    [/[\uac00-\ud7af]/, 'ko'], [/[\u3040-\u30ff]/, 'ja'], [/[\u4e00-\u9fff]/, 'zh']
  ];

  /* Function words, which are the cheapest reliable signal in Latin script.
     Short lists on purpose: these are meant to separate languages, not to
     be a dictionary. */
  var WORDS = {
    en: 'the and is it you that of to in was for with have this are not but',
    es: 'el la los las que de y en un una por con para no es se pero como',
    fr: 'le la les des que de et en un une pour avec pas est je ne vous',
    de: 'der die das und ist nicht ein eine mit von zu auf für ich sie aber',
    it: 'il la le che di e un una per con non sono come questo ma anche',
    pt: 'o a os as que de e em um uma por com nao para mas como isso',
    nl: 'de het een en is niet van met voor op maar zijn dat ik je',
    pl: 'nie to jest i w na z do sie że ale jak tego po co',
    tr: 've bir bu da de için ile ne var yok ama gibi daha çok en',
    id: 'yang dan di ke dari itu ini untuk tidak dengan pada saya kamu ada',
    ro: 'si de la in un o care nu este cu pentru dar ca mai sa',
    sv: 'och att det som en är för på av med inte den har jag'
  };
  var WORDSET = (function () {
    var m = {};
    Object.keys(WORDS).forEach(function (k) {
      m[k] = {};
      WORDS[k].split(' ').forEach(function (w) { m[k][w] = 1; });
    });
    return m;
  })();

  function detectLang(text) {
    var t = String(text || '');
    if (!t.trim()) return '';
    for (var i = 0; i < SCRIPT.length; i++) if (SCRIPT[i][0].test(t)) return SCRIPT[i][1];

    var words = t.toLowerCase().replace(/[^a-zà-ÿğışçöü\s']/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length < 2) return '';
    var best = '', bestScore = 0;
    Object.keys(WORDSET).forEach(function (lang) {
      var n = 0;
      for (var i = 0; i < words.length; i++) if (WORDSET[lang][words[i]]) n++;
      var score = n / words.length;
      if (score > bestScore) { bestScore = score; best = lang; }
    });
    /* Below this it is a guess, and a guess about the source language makes
       the translation worse rather than better. */
    return bestScore >= 0.12 ? best : '';
  }

  /* ---- the auto language lock ---- */
  var CANDIDATES = ['en-GB', 'es-ES', 'fr-FR', 'de-DE', 'ar-SA', 'hi-IN', 'zh-CN', 'pl-PL'];
  var confHist = [];
  var tried = {}, locked = false;

  function candidateList() {
    var dev = navigator.language || 'en-GB';
    var out = [dev];
    CANDIDATES.forEach(function (c) { if (out.indexOf(c) === -1) out.push(c); });
    return out;
  }

  /* Called with each finished result's own confidence. Six poor ones in a
     row means we are listening for the wrong language. */
  function judge(conf, text) {
    if (SET.get('capFrom') !== 'auto' || locked) return;
    var heard = detectLang(text);
    if (heard && heard === shortOf(rec ? rec.lang : '')) { locked = true; return; }
    confHist.push(typeof conf === 'number' ? conf : 0);
    while (confHist.length > 6) confHist.shift();
    if (confHist.length < 6) return;
    var mean = confHist.reduce(function (a, b) { return a + b; }, 0) / confHist.length;
    if (mean >= 0.55) { locked = true; return; }

    /* If the text itself looks like a language, go straight to it rather
       than working through the list. */
    var want = null;
    if (heard) {
      candidateList().forEach(function (c) { if (!want && shortOf(c) === heard) want = c; });
    }
    if (!want) {
      var list = candidateList();
      for (var i = 0; i < list.length; i++) if (!tried[list[i]]) { want = list[i]; break; }
    }
    if (!want || want === (rec && rec.lang)) return;
    tried[want] = 1;
    confHist = [];
    autoLang = want;
    note('LISTENING FOR ' + want.toUpperCase());
    try { if (rec) rec.abort(); } catch (e) {}
  }
  var autoLang = '';
  function health() { return { supported: !!SR, wantOn: wantOn, listening: on,
                               note: lastNote, netFails: netFails,
                               quietMs: lastSign ? Date.now() - lastSign : -1 }; }

  function srcLang() {
    var v = SET.get('capFrom');
    if (v && v !== 'auto') return v;
    return autoLang || navigator.language || 'en-GB';
  }
  function shortOf(code) { return String(code || '').split('-')[0].toLowerCase(); }

  function start() {
    wantOn = true;
    if (arguments[0] === 'captions') silent = false;
    if (!supported()) {
      /* No recogniser in this browser. Rather than refusing - which is what
         "captions don't work" looked like on the owner's iPad - record a few
         seconds at a time and have them transcribed. */
      if (canRecord()) { note('STARTING'); return startRecording(); }
      note('NOT SUPPORTED BY THIS BROWSER');
      U.toast('This browser has no speech recognition, and there is no endpoint set to transcribe audio instead.', 6500);
      wantOn = false;
      return false;
    }
    netFails = 0;
    sign();
    note('STARTING');
    watch();
    spin();
    return true;
  }

  function spin() {
    if (!wantOn || on) return;
    try { rec = new SR(); } catch (e) { U.toast('Could not start captions'); wantOn = false; return; }

    rec.lang = srcLang();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = function () { on = true; sign(); netFails = 0; note('LISTENING'); UI.captionState('listening'); };

    rec.onresult = function (ev) {
      /* Engines flush a final result AFTER stop(). Without this guard that
         late result redraws the caption bar the user just closed. */
      if (!wantOn) return;
      sign();
      note('LISTENING');
      var fresh = '';
      interim = '';
      var conf = null;
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) { fresh += r[0].transcript; conf = r[0].confidence; }
        else interim += r[0].transcript;
      }
      if (interim) { UI.captionDraw(lines, interim, null); tellPartial(interim); }
      if (fresh.trim()) {
        judge(conf, fresh);
        tellHeard(fresh.trim());
        if (!silent) push(fresh.trim());
      }
    };

    rec.onerror = function (ev) {
      var e = ev.error;
      sign();
      if (e === 'not-allowed' || e === 'service-not-allowed') {
        wantOn = false; on = false;
        clearInterval(watchdog); watchdog = null;
        note('MICROPHONE BLOCKED');
        UI.captionState('denied');
        U.toast('Microphone permission is needed for captions');
        return;
      }
      if (e === 'no-speech') { note('NO SPEECH HEARD'); return; }
      if (e === 'aborted') { return; }
      if (e === 'network') {
        /* Safari sends the audio away to be recognised and that request
           fails often. After a few goes, stop waiting for it and record
           instead - the app's own transcription needs nothing from the
           browser but a microphone. */
        netFails++;
        if (netFails > 3 && canRecord() && !recording) {
          note('SWITCHING TO RECORDED CAPTIONS');
          try { if (rec) rec.abort(); } catch (e2) {}
          startRecording();
          return;
        }
        note('RECONNECTING (' + netFails + ')');
        return;
      }
      note(String(e || 'error').toUpperCase().replace(/-/g, ' '));
      UI.captionState('error');
    };

    /* Engines stop on their own after silence. Respin unless we were asked
       to stop, with a small gap so a permission failure cannot hot-loop. */
    rec.onend = function () {
      on = false;
      sign();
      if (!wantOn) { UI.captionState('off'); return; }
      if (held) { UI.captionState('paused'); return; }   // the app is talking; resume() respins
      UI.captionState('paused');
      clearTimeout(restartTimer);
      /* Back off when the service keeps refusing, so a broken network does
         not become a restart loop that flattens the battery. */
      var gap = netFails > 3 ? Math.min(6000, 600 * netFails) : 350;
      restartTimer = setTimeout(spin, gap);
    };

    try { rec.start(); }
    catch (e) { on = false; clearTimeout(restartTimer); restartTimer = setTimeout(spin, 600); }
  }

  /* ---- recorded captions -----------------------------------------------

     The fallback, and on some phones the only thing that works at all. A few
     seconds of audio at a time go to the endpoint's Whisper route, which
     returns the words AND the language it heard - so translating into
     English needs nobody to say what language is being spoken.

     Only ever a few seconds are held, in memory, and each clip is discarded
     the moment it has been sent. */
  var mediaStream = null, recorder = null, recording = false, chunkTimer = null;
  var CHUNK_MS = 4500;

  function canRecord() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
              window.MediaRecorder && SET.hasApi());
  }

  function startRecording() {
    if (recording) return true;
    recording = true;
    note('ASKING FOR THE MICROPHONE');
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (st) {
      if (!wantOn) { st.getTracks().forEach(function (t) { t.stop(); }); recording = false; return; }
      mediaStream = st;
      note('LISTENING');
      UI.captionState('listening');
      cycle();
    }).catch(function (e) {
      recording = false;
      wantOn = false;
      note('MICROPHONE BLOCKED');
      UI.captionState('denied');
      U.toast('Captions need the microphone. Allow it and press CC again.', 5000);
    });
    return true;
  }

  /* One clip at a time: start, wait, stop, send, repeat. Chunking a single
     long recording does not work - a slice of a webm stream is not a file
     the decoder can open on its own. */
  function cycle() {
    if (!wantOn || !mediaStream) return;
    var parts = [];
    var mr;
    try { mr = new MediaRecorder(mediaStream, pickMime()); }
    catch (e) { try { mr = new MediaRecorder(mediaStream); } catch (e2) { note('CANNOT RECORD HERE'); return; } }
    recorder = mr;
    mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) parts.push(ev.data); };
    mr.onstop = function () {
      if (parts.length) send(new Blob(parts, { type: mr.mimeType || 'audio/webm' }));
      parts = [];
      if (wantOn) chunkTimer = setTimeout(cycle, 60);
    };
    try { mr.start(); } catch (e) { note('CANNOT RECORD HERE'); return; }
    sign();
    chunkTimer = setTimeout(function () {
      try { if (mr.state !== 'inactive') mr.stop(); } catch (e) {}
    }, CHUNK_MS);
  }

  function pickMime() {
    var want = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < want.length; i++) {
      if (window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(want[i])) {
        return { mimeType: want[i] };
      }
    }
    return {};
  }

  function send(blob) {
    if (!wantOn || blob.size < 2000) return;      // a clip of silence
    var fr = new FileReader();
    fr.onload = function () {
      if (!wantOn) return;
      sign();
      IDENT.post('/v1/transcribe', { audio: String(fr.result) })
        .then(function (r) {
          if (!wantOn) return;
          if (r && r.ok && r.text) {
            note('LISTENING');
            tellHeard(r.text.trim());
            if (!silent) push(r.text.trim(), r.language || '');
          }
          else note('NOTHING HEARD');
        })
        .catch(function (e) {
          note('TRANSCRIBE FAILED - ' + String(e && e.message || e).slice(0, 40).toUpperCase());
        });
    };
    fr.readAsDataURL(blob);
  }

  function stopRecording() {
    recording = false;
    clearTimeout(chunkTimer);
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
    recorder = null;
    if (mediaStream) { mediaStream.getTracks().forEach(function (t) { t.stop(); }); mediaStream = null; }
  }

  /* Stopping CLEARS. Leaving the text on screen after the user switched
     captions off is the bug this fixes, and making every caller remember to
     call clear() separately is how it would come back. */
  function stop() {
    wantOn = false;
    clearTimeout(restartTimer);
    clearInterval(watchdog); watchdog = null;
    netFails = 0;
    confHist = []; tried = {}; locked = false; autoLang = '';
    stopRecording();
    note('');
    if (rec) {
      /* abort() discards a pending utterance; stop() delivers it, which is
         exactly the late result that redrew the bar. */
      try { rec.abort(); }
      catch (e) { try { rec.stop(); } catch (e2) { /* already stopped */ } }
    }
    on = false;
    lines = [];
    interim = '';
    UI.captionDraw(lines, '', null);
    UI.captionState('off');
  }

  function clear() { lines = []; interim = ''; UI.captionDraw(lines, '', null); }

  function push(text, heardLang) {
    if (!wantOn) return;
    var line = { src: text, out: '', pending: false };
    lines.push(line);
    while (lines.length > 4) lines.shift();
    UI.captionDraw(lines, '', null);

    var to = SET.get('capTo') || 'en';
    /* The language is read off the words that came back, not off a setting.
       That is what makes "hear French, read English" work without the
       listener having to tell the app what they are about to hear. */
    /* Whisper says which language it heard, which beats guessing from the
       words; the word-based detector is the fallback for the browser's own
       recogniser, which says nothing. */
    var from = shortOf(heardLang || '') || detectLang(text) || shortOf(srcLang());
    line.from = from;
    if (!to || to === from) { line.out = text; UI.captionDraw(lines, interim, null); return; }

    var key = from + '>' + to + ':' + text;
    var hit = tcache.get(key);
    if (hit) { line.out = hit; UI.captionDraw(lines, interim, null); return; }

    if (!SET.hasApi()) {
      line.out = text;
      line.note = 'no endpoint - showing the original';
      UI.captionDraw(lines, interim, null);
      return;
    }

    line.pending = true;
    IDENT.post('/v1/translate', { text: text, from: from, to: to })
      .then(function (r) {
        line.pending = false;
        if (r && r.ok && r.text) { line.out = r.text; tcache.set(key, r.text); }
        else { line.out = text; line.note = 'not translated'; }
        if (wantOn) UI.captionDraw(lines, interim, null);
      })
      .catch(function () {
        line.pending = false;
        line.out = text;
        line.note = 'translation unavailable';
        if (wantOn) UI.captionDraw(lines, interim, null);
      });
  }

  /* Re-listen in the new language when the source is changed mid-session. */
  function relang() {
    if (!wantOn) return;
    try { if (rec) rec.abort(); } catch (e) { /* ignore */ }
    on = false;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(spin, 200);
  }

  function running() { return wantOn; }

  /* SHARED EARS.

     The voice assistant listens for its wake word in the same lines the
     captions produce. One recogniser, two readers - a second one would mean
     a second microphone stream and, on the browsers that send audio away to
     be recognised, sending it twice. */
  /* THE PARTIAL TEXT, AS IT GROWS.

     "i talk, no response. like siri it should detect when i stop talking."

     tellHeard only ever fired on a FINAL result, and with continuous
     recognition an engine can hold a final for seconds - or never send one
     while somebody keeps talking. So the assistant sat there with the
     words on screen and nothing happening. The partial is handed out as it
     grows and the listener decides when it has stopped growing, which is
     the only way to know somebody has finished a sentence. */
  var partialFns = [];
  function onPartial(fn) { if (partialFns.indexOf(fn) === -1) partialFns.push(fn); }
  function offPartial(fn) { partialFns = partialFns.filter(function (f) { return f !== fn; }); }
  function tellPartial(text) { partialFns.forEach(function (f) { try { f(text); } catch (e) {} }); }

  var heardFns = [];
  function onHeard(fn) { if (heardFns.indexOf(fn) === -1) heardFns.push(fn); }
  function offHeard(fn) { heardFns = heardFns.filter(function (f) { return f !== fn; }); }
  function tellHeard(text) { heardFns.forEach(function (f) { try { f(text); } catch (e) {} }); }

  /* HELD WHILE THE APP SPEAKS.

     "it can no longer hear me." On a phone the recogniser and the speaker
     share one audio path: an answer read aloud ends recognition with
     'aborted', the respin lands while the voice is still talking, and
     what it then hears is the app itself. So the microphone is put on
     hold for the length of the answer and respun when it is done. */
  var held = false;
  function hold(v) {
    v = !!v;
    if (v === held) return;
    held = v;
    if (held) { try { if (rec && on) rec.abort(); } catch (e) {} return; }
    if (wantOn && !on) { clearTimeout(restartTimer); restartTimer = setTimeout(spin, 250); }
  }
  function isHeld() { return held; }

  /* Start listening without showing captions - what the assistant needs. */
  function listen() {
    if (wantOn) return true;
    silent = true;
    return start();
  }
  var silent = false;
  function isSilent() { return silent; }

  return { LANGS: LANGS, TARGETS: TARGETS, supported: supported, start: start,
           stop: stop, clear: clear, relang: relang, running: running,
           shortOf: shortOf, health: health, detectLang: detectLang,
           canRecord: canRecord, recording: function () { return recording; },
           onHeard: onHeard, offHeard: offHeard, listen: listen, isSilent: isSilent,
           hold: hold, isHeld: isHeld,
           onPartial: onPartial, offPartial: offPartial, _tellPartial: tellPartial };
})();
