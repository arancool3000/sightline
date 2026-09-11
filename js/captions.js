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

  function supported() { return !!SR; }

  function srcLang() {
    var v = SET.get('capFrom');
    if (v && v !== 'auto') return v;
    return navigator.language || 'en-GB';
  }
  function shortOf(code) { return String(code || '').split('-')[0].toLowerCase(); }

  function start() {
    if (!supported()) { U.toast('This browser has no speech recognition. Try Chrome, Edge or Safari.'); return false; }
    wantOn = true;
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

    rec.onstart = function () { on = true; UI.captionState('listening'); };

    rec.onresult = function (ev) {
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
      if (e === 'not-allowed' || e === 'service-not-allowed') {
        wantOn = false; on = false;
        UI.captionState('denied');
        U.toast('Microphone permission is needed for captions');
        return;
      }
      if (e === 'no-speech' || e === 'aborted' || e === 'network') return;   // onend restarts
      UI.captionState('error');
    };

    /* Engines stop on their own after silence. Respin unless we were asked
       to stop, with a small gap so a permission failure cannot hot-loop. */
    rec.onend = function () {
      on = false;
      if (!wantOn) { UI.captionState('off'); return; }
      UI.captionState('paused');
      clearTimeout(restartTimer);
      restartTimer = setTimeout(spin, 350);
    };

    try { rec.start(); }
    catch (e) { on = false; clearTimeout(restartTimer); restartTimer = setTimeout(spin, 600); }
  }

  function stop() {
    wantOn = false;
    clearTimeout(restartTimer);
    if (rec) { try { rec.stop(); } catch (e) { /* already stopped */ } }
    on = false;
    interim = '';
    UI.captionState('off');
  }

  function clear() { lines = []; interim = ''; UI.captionDraw(lines, '', null); }

  function push(text) {
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
        UI.captionDraw(lines, interim, null);
      })
      .catch(function () {
        line.pending = false;
        line.out = text;
        line.note = 'translation unavailable';
        UI.captionDraw(lines, interim, null);
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
           stop: stop, clear: clear, relang: relang, running: running, shortOf: shortOf };
})();
