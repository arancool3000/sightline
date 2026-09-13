/* Sightline - talking to it.

   "hey vision" and then a question. It answers out loud, and it can change
   what is on the screen while it does: box a particular thing, colour the
   boxes differently, hide what it is not talking about.

   THE WAKE WORD COSTS NOTHING EXTRA. It is the same speech recogniser the
   captions already use - no second model, no audio uploaded to listen for a
   phrase. While it is waiting, every line it hears is checked for the wake
   word and thrown away. Only once woken does a question go anywhere.

   WHAT IT IS ALLOWED TO DO IS A FIXED LIST. The model does not get to run
   code; it returns an action from a vocabulary this file defines, and
   anything it asks for that is not on the list is ignored. That is the
   difference between a model driving an interface and a model being asked
   what it would like to see happen.                                       */
'use strict';

var VOICE = (function () {

  var WAKE = /\b(hey|hi|ok|okay)\s+(vision|sightline)\b/i;
  /* Said without the "hey", because people do. */
  var BARE = /^\s*(vision|sightline)[,\s]/i;

  var on = false;          // the wake word is being listened for
  var awake = false;       // a question is being taken right now
  var awakeUntil = 0;
  var AWAKE_MS = 8000;     // how long it waits for a question after the wake word
  /* "the ai should automatically stop listening when it feels it is
     appropriate to." Once a question has been answered the window closes
     itself - unless the answer asked something back, in which case it
     stays open just long enough for a reply. */
  var FOLLOWUP_MS = 5000, ASKBACK_MS = 9000;
  var thinking = false;
  var lastSaid = '';
  var lastAnswer = null;
  var listeners = [];

  function fire(what) { listeners.forEach(function (f) { try { f(what); } catch (e) {} }); }
  function onEvent(fn) { listeners.push(fn); }

  function state() {
    return { on: on, awake: awake, thinking: thinking, awakeMs: awakeMs(),
             tts: { gemini: ttsSpoken, device: ttsFellBack },
             heard: lastSaid, answer: lastAnswer,
             engine: GEM.has() ? 'gemini' : (SET.hasApi() ? 'worker' : 'none') };
  }

  function start() {
    if (on) return true;
    if (!CAPS.supported() && !CAPS.canRecord()) return false;
    on = true;
    CAPS.onHeard(heard);
    if (CAPS.onPartial) CAPS.onPartial(onPartial);
    CAPS.listen();           // shared with captions: one recogniser, two readers
    fire({ kind: 'listening' });
    return true;
  }

  function stop() {
    if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = 0; }
    on = false; awake = false; thinking = false;
    if (endTimer) { clearTimeout(endTimer); endTimer = 0; }
    partial = '';
    CAPS.offHeard(heard);
    if (CAPS.offPartial) CAPS.offPartial(onPartial);
    fire({ kind: 'off' });
  }

  /* Every finished line the recogniser produces passes through here. While
     asleep it is only ever compared against the wake word and dropped. */
  /* ---- KNOWING WHEN YOU HAVE FINISHED ----

     "i talk, no response. like siri it should detect when i stop talking."

     The recogniser only reported a FINAL result, and with continuous
     recognition an engine can hold one for seconds, or never send it at
     all while somebody keeps talking. So the words appeared on screen and
     nothing happened.

     The partial text is watched instead: every time it grows the clock is
     reset, and when it has not grown for END_MS the sentence is over.
     That is what a person means by "I have stopped talking" - not silence
     in the microphone, which a room never gives you, but the words
     stopping. A final that arrives afterwards says the same thing, so the
     two are deduplicated rather than asked twice. */
  var END_MS = 850;
  var partial = '', endTimer = 0, lastTaken = '', lastTakenAt = 0;

  function onPartial(text) {
    if (!on) return;
    if (window.LIVE && LIVE.healthy()) return;
    var t = String(text || '').trim();
    if (!t) return;

    /* Waking is instant: nobody should have to finish a sentence before
       the app admits it heard its own name. */
    if (!awake && (WAKE.test(t) || BARE.test(t))) { wake(); }

    if (!awake || thinking) return;
    partial = t;
    if (endTimer) clearTimeout(endTimer);
    endTimer = setTimeout(function () {
      endTimer = 0;
      var said = partial; partial = '';
      if (said) take(said);
    }, END_MS);
  }

  function heard(text) {
    if (!on) return;
    /* While the live session is HEARING - not merely connected - it has
       the microphone and the on-device copy would ask everything twice. */
    if (window.LIVE && LIVE.healthy()) return;
    if (endTimer) { clearTimeout(endTimer); endTimer = 0; }
    partial = '';
    var line = String(text || '').trim();
    if (!line) return;
    take(line);
  }

  /* One door, whether the words came from a final result or from noticing
     that they stopped arriving. */
  function take(line) {
    /* The final almost always repeats what the endpoint already took. */
    if (line === lastTaken && (Date.now() - lastTakenAt) < 5000) return;
    lastTaken = line; lastTakenAt = Date.now();

    if (!awake) {
      var m = line.match(WAKE) || line.match(BARE);
      if (!m) return;
      /* Anything after the wake word in the same breath is the question. */
      var rest = line.slice(line.toLowerCase().indexOf(m[0].toLowerCase()) + m[0].length).trim();
      wake();
      if (rest.length > 3) {
        /* Said in one breath - "hey vision show the map" - is the same
           instruction as saying it after the wake word, and used to skip
           the built-ins entirely and go straight to the model. */
        var quick = window.CMD ? CMD.run(rest) : null;
        if (quick) { local(quick); return; }
        askNow(rest);
      }
      return;
    }

    if (performance.now() > awakeUntil) { awake = false; fire({ kind: 'listening' }); return; }

    /* THE BUILT-INS GO FIRST, EVERY TIME.

       "built in voice commands which get checked before sent to gemini
        like show map or select subject n more complex commands are handed
        to gemini."

       So most of what anybody says never leaves the device: no wait, no
       quota, and it works with no signal. Anything the table does not
       recognise falls through to the model exactly as before. */
    var did = window.CMD ? CMD.run(line) : null;
    if (did) { local(did); return; }

    askNow(line);
  }

  /* A built-in that has already acted. It speaks like any other answer, so
     from the outside a local command and a model answer are the same
     thing - which is the point: the reader should not have to know which
     of the two happened. */
  function local(res) {
    lastAnswer = { say: res.say || '', local: true, command: res.name || '' };
    fire({ kind: 'answer', answer: lastAnswer });
    speak(lastAnswer.say);
    settle(lastAnswer.say);
    /* Some of them finish later - a place has to be looked up. The second
       answer replaces the first rather than talking over it. */
    if (res.then && res.then.then) {
      res.then.then(function (r2) {
        if (!r2 || !r2.say) return;
        lastAnswer = { say: r2.say, local: true, command: res.name || '' };
        fire({ kind: 'answer', answer: lastAnswer });
        speak(r2.say);
      });
    }
    return lastAnswer;
  }

  /* Done with this exchange? A plain answer means yes - it goes back to
     sleep and waits for the wake word. An answer that ends in a question
     means it is waiting on you, so the window stays open a moment. */
  function settle(said) {
    /* "it can no longer hear me" - the first cut closed the window the
       instant an answer was given, so the follow-up everybody says next
       ("and how far is it?") went unheard until they said the wake word
       again. Stopping when appropriate means AFTER the pause that follows
       an answer, not before it. A plain answer keeps the ear open a few
       seconds; one that asks something back, longer. */
    var asksBack = /\?\s*$/.test(String(said || '').trim());
    var ms = asksBack ? ASKBACK_MS : FOLLOWUP_MS;
    awake = true;
    awakeUntil = performance.now() + ms;
    armClose(ms);
  }
  function armClose(ms) {
    if (awakeTimer) clearTimeout(awakeTimer);
    awakeTimer = setTimeout(function () {
      awakeTimer = 0;
      if (!awake || thinking) return;
      if (performance.now() < awakeUntil) return;
      awake = false;
      fire({ kind: 'listening' });
    }, ms + 60);
  }

  var awakeTimer = 0;
  /* How much longer it is really listening. The strip is held for exactly
     this, so what is on screen and what the microphone is doing cannot
     drift apart. */
  function awakeMs() {
    var left = awakeUntil - performance.now();
    return awake && left > 0 ? Math.round(left) : 0;
  }

  function wake() {
    /* THE LIVE SESSION IS THE REAL CONVERSATION.

       On the owner's own quota page the Live models are UNLIMITED on the
       free tier while the speech models are ten requests a DAY. So when
       there is a key, waking opens a live socket: the microphone goes
       straight up, the answer comes straight back as speech, and both
       sides come back as text for the captions. The on-device recogniser
       keeps the wake word because it costs nothing, and stays the whole
       assistant when there is no key. */
    if (window.LIVE && LIVE.available() && !LIVE.running()) {
      LIVE.start().then(function (ok) {
        if (ok && CAM && CAM.frame) LIVE.look(CAM.frame(512));
      });
    }
    awake = true;
    awakeUntil = performance.now() + AWAKE_MS;
    lastSaid = '';
    /* Nothing used to close the window except the next thing anybody said,
       so with nobody speaking it stayed "awake" until it was spoken to.
       Now the window closes itself and says so. */
    armClose(AWAKE_MS);
    fire({ kind: 'awake' });
  }

  /* ---- what it may do ----

     A fixed vocabulary. The model chooses from this; it does not get to
     invent an instruction, and anything it names that is not here is
     dropped rather than guessed at. */
  var ACTIONS = {
    /* box: {what} - draw attention to whatever matches that word */
    box: function (a) { fire({ kind: 'box', what: String(a.what || ''), colour: a.colour || '' }); },
    /* only: {what} - hide the boxes that are not this */
    only: function (a) { fire({ kind: 'only', what: String(a.what || '') }); },
    /* clear: put everything back */
    clear: function () { fire({ kind: 'clear' }); },
    /* colour: {what, colour} */
    colour: function (a) { fire({ kind: 'box', what: String(a.what || ''), colour: String(a.colour || '') }); },
    /* say: nothing to change, just the words */
    say: function () {},

    /* ---- THE REST OF THE APP, AS TOOLS ----

       "gemini should have even more tool calls it can use."

       Every one of these goes through CMD, the same table a spoken
       command goes through, which presses the same control a finger
       would. So the model cannot reach anything a person cannot, cannot
       invent an instruction, and the two ways of asking can never drift
       apart - there is one implementation and it is the one already
       tested. Anything it names that is not here is dropped. */

    /* map: {open:true|false} */
    map: function (a) { viaWords(a.open === false ? 'close the map' : 'show the map'); },
    /* zoom: {way:"in"|"out"} */
    zoom: function (a) { viaWords('zoom ' + (String(a.way || 'in').toLowerCase() === 'out' ? 'out' : 'in')); },
    /* follow: back to where you are */
    follow: function () { viaWords('follow me'); },
    /* layer: {name:"buildings"|"streets"|"places"|"route", on:true|false} */
    layer: function (a) {
      var n = String(a.name || '').toLowerCase();
      if (!n) return;
      viaWords((a.on === false ? 'hide the ' : 'show the ') + n);
    },
    /* scan: look for a code now */
    scan: function () { viaWords('scan this code'); },
    /* subject: take a closer look at what is in the middle */
    subject: function () { viaWords('identify the subject'); },
    /* navigate: {to:"the post office"} */
    navigate: function (a) {
      var to = String(a.to || '').trim();
      if (to) viaWords('directions to ' + to);
    },
    /* stopNavigation: put the route away */
    stopNavigation: function () { viaWords('stop directions'); },
    /* captions: {on:true|false} */
    captions: function (a) { viaWords((a.on === false ? 'turn off ' : 'turn on ') + 'the captions'); }
  };

  /* A tool call is spoken to the same table a person speaks to. If the
     table cannot do it, neither can the model. */
  function viaWords(line) {
    if (!window.CMD) return;
    var r = CMD.run(line);
    if (r && r.then && r.then.then) r.then.then(function () {});
  }

  function apply(list) {
    if (!Array.isArray(list)) return 0;
    var n = 0;
    list.slice(0, 6).forEach(function (a) {
      if (!a || typeof a.do !== 'string') return;
      var fn = ACTIONS[a.do.toLowerCase()];
      if (!fn) return;                       // not in the vocabulary: ignored
      fn(a); n++;
    });
    return n;
  }

  var PROMPT =
    'You are the voice of a camera app. The picture is what its camera can see right now.\n' +
    'Answer the question in ONE or TWO short spoken sentences - it is read aloud, so no lists ' +
    'and no markdown.\n' +
    'You may also ask the display to change. Reply as JSON:\n' +
    '{"say":"...","actions":[{"do":"box","what":"the bicycle","colour":"green"}]}\n' +
    'Allowed "do" values and nothing else: box, only, colour, clear, say, map, zoom, ' +
    'follow, layer, scan, subject, navigate, stopNavigation, captions.\n' +
    '"what" is a word or two naming the thing, as a person would say it.\n' +
    '"colour" may be green, blue, amber, pink or red.\n' +
    'map takes {"open":true|false}; zoom takes {"way":"in"|"out"}; layer takes ' +
    '{"name":"buildings"|"streets"|"places"|"route","on":true|false}; navigate takes ' +
    '{"to":"the post office"}. follow, scan, subject, stopNavigation take nothing. ' +
    'captions takes {"on":true|false}.\n' +
    'Use actions only when they help. If you are not sure what something is, say so plainly ' +
    'rather than guessing - a wrong name is worse than "I cannot tell from here".';

  /* "takes ages for it to respond and sometimes forgets to respond."

     FORGETS: askNow() returned early while a previous question was still
     in flight, and said nothing - so the second thing you asked simply
     vanished. And if the request hung, `thinking` stayed true for ever
     and EVERY later question vanished. Now a question asked mid-answer
     is kept and asked next, and a watchdog clears a hung request with an
     answer that says so.

     AGES: every question carried a 768px photograph, whether or not it
     was about the picture. "How far is the station" is text. A text-only
     request is a fraction of the bytes and the model answers it in a
     fraction of the time; the picture goes only with a scene question,
     and smaller. */
  var ASK_TIMEOUT_MS = 20000, pendingQ = null, watchdog = 0;

  function askNow(question) {
    if (thinking) { pendingQ = question; return; }
    lastSaid = question;
    thinking = true;
    awakeUntil = performance.now() + AWAKE_MS;
    fire({ kind: 'thinking', question: question });
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      watchdog = 0;
      if (!thinking) return;
      thinking = false;
      lastAnswer = { say: 'That took too long. Ask me again.', error: 'timeout' };
      fire({ kind: 'answer', answer: lastAnswer });
      speak(lastAnswer.say);
      settle('');
      drain();
    }, ASK_TIMEOUT_MS);

    var scene = isSceneQuestion(question);
    var shot = (scene && CAM.frame) ? CAM.frame(512) : null;

    /* "the labels confuse it. if the message is related to the scene in
        front of it it should analyse without looking at the labels
        properly and then label things itsself."

       Right: handed "things it has boxed: cup, laptop", the model answers
       about cups and laptops whether or not that is what is there. So a
       question about the scene gets the PICTURE and nothing else, and is
       asked to name what it sees; those names come back in "seen" and are
       boxed from the model's own answer. A question that is not about the
       scene - directions, the weather, a fact - still gets the context,
       because there the labels are the point. */
    var full = PROMPT +
               (scene ? '\n\nLook at the picture yourself. Ignore any labels you might expect an app to have; ' +
                        'name what YOU see. Put the two to six things worth naming in "seen" as ' +
                        '[{"what":"golden retriever","colour":"green"}], most important first, using ' +
                        'the specific name (a breed, a model, a species) when you can see it.'
                      : '\n\nWhat the app has already worked out: ' + context()) +
               '\n\nThe question: ' + question;

    var job = GEM.has()
      ? GEM.ask(full, shot, { json: true, maxTokens: 320 })
      : IDENT.post('/v1/ask', { prompt: full, image: shot })
          .then(function (r) { return r && r.ok ? { ok: true, text: r.text, json: null, model: 'worker' } : { ok: false, error: (r && r.error) || 'no answer' }; });

    return job.then(function (r) {
      if (!thinking) return lastAnswer;          // the watchdog already answered
      if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
      thinking = false;
      if (!r.ok) {
        lastAnswer = { say: 'I could not reach the assistant.', error: r.error };
        fire({ kind: 'answer', answer: lastAnswer });
        speak(lastAnswer.say);
        settle('');
        return lastAnswer;
      }
      var parsed = r.json;
      if (!parsed) { try { parsed = JSON.parse(pickJson(r.text)); } catch (e) {} }
      var say = (parsed && parsed.say) || r.text || '';
      var acts = (parsed && parsed.actions) || [];
      /* What the model saw becomes the boxes, in the order it named them. */
      if (scene && parsed && Array.isArray(parsed.seen)) {
        parsed.seen.slice(0, 6).forEach(function (s) {
          if (s && s.what) acts.push({ do: 'box', what: String(s.what), colour: s.colour || '' });
        });
      }
      apply(acts);
      lastAnswer = { say: say, actions: acts, model: r.model, scene: scene,
                     seen: (scene && parsed && parsed.seen) || [] };
      fire({ kind: 'answer', answer: lastAnswer });
      speak(say);
      settle(say);
      drain();
      return lastAnswer;
    }).catch(function (e) {
      if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
      thinking = false;
      lastAnswer = { say: 'Something went wrong asking that.', error: String(e && e.message || e) };
      fire({ kind: 'answer', answer: lastAnswer });
      settle('');
      drain();
      return lastAnswer;
    });
  }

  /* The question that arrived mid-answer gets asked now. */
  function drain() {
    var q = pendingQ; pendingQ = null;
    if (q) { awake = true; awakeUntil = performance.now() + AWAKE_MS; askNow(q); }
  }

  /* Is this about what is in front of the camera? Deliberately wide: the
     cost of a scene question getting the labels is the confusion the
     owner reported; the cost of a fact question losing them is small. */
  var SCENE = /\b(what|who|which|where)\b.*\b(this|that|these|those|here|it|see|seeing|looking at|in front|around me|on the (left|right)|over there)\b|\b(describe|look at|read|count|identify|is there|are there|can you see|do you see|how many)\b/i;
  function isSceneQuestion(q) { return SCENE.test(String(q || '')); }

  function pickJson(t) {
    var s = String(t || '');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    return (a !== -1 && b > a) ? s.slice(a, b + 1) : '{}';
  }

  /* What the app already knows, so the model is not asked to work out
     things that have been worked out. */
  function context() {
    var bits = [];
    var tracks = (window.TRACK && TRACK.visible) ? TRACK.visible() : [];
    var named = tracks.filter(function (t) { return t.label; })
                      .map(function (t) { return t.label; }).slice(0, 8);
    if (named.length) bits.push('objects it has named: ' + named.join(', '));
    var boxed = tracks.map(function (t) { return t.cls; }).slice(0, 10);
    if (boxed.length) bits.push('things it has boxed: ' + boxed.join(', '));
    var g = window.GEO && GEO.state();
    if (g && g.locality) bits.push('nearby: ' + g.locality);
    return bits.length ? bits.join('; ') : 'nothing identified yet';
  }

  /* ---- SPEAKING ----

     Gemini's own voice when a key is present and it is not at its limit;
     the device's voice otherwise. There is no third tier: every "free"
     neutral web voice either wants a key or caps you, and a service that
     caps you is not free unlimited - the device's speech engine is the one
     that never runs out. Whichever speaks, the other is silenced first so
     two answers never talk over each other. */
  var audioCtx = null, playing = null;
  var ttsSpoken = 0, ttsFellBack = 0;

  function hush() {
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
    try { if (playing) { playing.stop(); playing = null; } } catch (e) {}
  }
  /* The microphone is held while the app talks and released when it
     stops - by the utterance ending, the buffer ending, or a ceiling in
     case neither event ever comes. The follow-up window is re-armed on
     release so it starts when you can actually be heard. */
  var holdTimer = 0;
  function holdMic(on2) {
    if (!window.CAPS || !CAPS.hold) return;
    CAPS.hold(on2);
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
    if (on2) holdTimer = setTimeout(function () { holdTimer = 0; holdMic(false); }, 12000);
    else if (awake) { awakeUntil = Math.max(awakeUntil, performance.now() + FOLLOWUP_MS); armClose(FOLLOWUP_MS); }
  }
  function deviceSpeak(text) {
    if (!window.speechSynthesis) return false;
    try {
      var u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
      u.rate = 1.05;
      holdMic(true);
      u.onend = u.onerror = function () { holdMic(false); };
      speechSynthesis.speak(u);
      return true;
    } catch (e) { holdMic(false); return false; }
  }
  function playPcm(pcm, rate) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audioCtx = audioCtx || new AC();
    var buf = audioCtx.createBuffer(1, pcm.length, rate);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    var src = audioCtx.createBufferSource();
    src.buffer = buf; src.connect(audioCtx.destination);
    holdMic(true);
    src.onended = function () { if (playing === src) playing = null; holdMic(false); };
    playing = src; src.start();
    return true;
  }
  function speak(text) {
    text = String(text || '').trim();
    if (!text) return Promise.resolve('none');
    hush();
    var useGem = window.GEM && GEM.has && GEM.has() && GEM.tts && SET.get('geminiVoice') !== false;
    if (!useGem) { deviceSpeak(text); return Promise.resolve('device'); }
    /* The cloud voice is a second round trip after the answer. It gets a
       moment; past that the device speaks and whatever arrives later is
       dropped, because two voices saying the same thing is worse than a
       plainer one saying it now. */
    var spoken = false;
    var late = new Promise(function (res) { setTimeout(function () { res({ late: true }); }, TTS_WAIT_MS); });
    return Promise.race([GEM.tts(text), late]).then(function (r) {
      if (spoken) return 'device';
      spoken = true;
      if (r && r.ok && r.pcm && r.pcm.length && playPcm(r.pcm, r.rate)) { ttsSpoken++; return 'gemini'; }
      ttsFellBack++;
      deviceSpeak(text);
      return 'device';
    }, function () { if (spoken) return 'device'; spoken = true; ttsFellBack++; deviceSpeak(text); return 'device'; });
  }
  var TTS_WAIT_MS = 1500;

  return { start: start, stop: stop, state: state, on: onEvent, ask: askNow, awakeMs: awakeMs,
           wake: wake, speak: speak, speakDevice: deviceSpeak, _heard: heard, _apply: apply, _settle: settle,
           _pending: function () { return pendingQ; },
           _partial: onPartial, _endMs: function () { return END_MS; }, _setEndMs: function (v) { END_MS = v; }, _timeoutMs: ASK_TIMEOUT_MS, _setTimeoutMs: function (v) { ASK_TIMEOUT_MS = v; },
           _setFollowupMs: function (v) { FOLLOWUP_MS = v; }, _followupMs: function () { return FOLLOWUP_MS; },
           isSceneQuestion: isSceneQuestion,
           WAKE: WAKE, ACTIONS: ACTIONS };
})();
