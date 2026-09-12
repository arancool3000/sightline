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
  function health() { return { supported: !!SR, wantOn: wantOn, listening: on,
                               note: lastNote, netFails: netFails,
                               quietMs: lastSign ? Date.now() - lastSign : -1 }; }

  function srcLang() {
    var v = SET.get('capFrom');
    if (v && v !== 'auto') return v;
    return navigator.language || 'en-GB';
  }
  function shortOf(code) { return String(code || '').split('-')[0].toLowerCase(); }

  function start() {
    if (!supported()) {
      note('NOT SUPPORTED BY THIS BROWSER');
      U.toast('This browser has no speech recognition. Chrome and Edge have it; Safari on iOS often does not.', 6000);
      return false;
    }
    wantOn = true;
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
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) fresh += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) UI.captionDraw(lines, interim, null);
      if (fresh.trim()) push(fresh.trim());
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
        /* Safari sends the audio to a server to be recognised, and that
           request fails often. Backing off beats hammering it, and saying so
           beats an empty bar. */
        netFails++;
        note(netFails > 3 ? 'SPEECH SERVICE UNREACHABLE - STILL TRYING'
                          : 'RECONNECTING (' + netFails + ')');
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

  /* Stopping CLEARS. Leaving the text on screen after the user switched
     captions off is the bug this fixes, and making every caller remember to
     call clear() separately is how it would come back. */
  function stop() {
    wantOn = false;
    clearTimeout(restartTimer);
    clearInterval(watchdog); watchdog = null;
    netFails = 0;
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

  function push(text) {
    if (!wantOn) return;
    var line = { src: text, out: '', pending: false };
    lines.push(line);
    while (lines.length > 4) lines.shift();
    UI.captionDraw(lines, '', null);

    var to = SET.get('capTo');
    var from = shortOf(srcLang());
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

  return { LANGS: LANGS, TARGETS: TARGETS, supported: supported, start: start,
           stop: stop, clear: clear, relang: relang, running: running,
           shortOf: shortOf, health: health };
})();
