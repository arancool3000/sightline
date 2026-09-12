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
  var AWAKE_MS = 8000;     // how long it keeps listening after waking
  var thinking = false;
  var lastSaid = '';
  var lastAnswer = null;
  var listeners = [];

  function fire(what) { listeners.forEach(function (f) { try { f(what); } catch (e) {} }); }
  function onEvent(fn) { listeners.push(fn); }

  function state() {
    return { on: on, awake: awake, thinking: thinking, awakeMs: awakeMs(),
             heard: lastSaid, answer: lastAnswer,
             engine: GEM.has() ? 'gemini' : (SET.hasApi() ? 'worker' : 'none') };
  }

  function start() {
    if (on) return true;
    if (!CAPS.supported() && !CAPS.canRecord()) return false;
    on = true;
    CAPS.onHeard(heard);
    CAPS.listen();           // shared with captions: one recogniser, two readers
    fire({ kind: 'listening' });
    return true;
  }

  function stop() {
    if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = 0; }
    on = false; awake = false; thinking = false;
    CAPS.offHeard(heard);
    fire({ kind: 'off' });
  }

  /* Every finished line the recogniser produces passes through here. While
     asleep it is only ever compared against the wake word and dropped. */
  function heard(text) {
    if (!on) return;
    var line = String(text || '').trim();
    if (!line) return;

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
    awakeUntil = performance.now() + AWAKE_MS;
    lastAnswer = { say: res.say || '', local: true, command: res.name || '' };
    fire({ kind: 'answer', answer: lastAnswer });
    speak(lastAnswer.say);
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

  var awakeTimer = 0;
  /* How much longer it is really listening. The strip is held for exactly
     this, so what is on screen and what the microphone is doing cannot
     drift apart. */
  function awakeMs() {
    var left = awakeUntil - performance.now();
    return awake && left > 0 ? Math.round(left) : 0;
  }

  function wake() {
    awake = true;
    awakeUntil = performance.now() + AWAKE_MS;
    lastSaid = '';
    /* Nothing used to close the window except the next thing anybody said,
       so with nobody speaking it stayed "awake" until it was spoken to.
       Now the window closes itself and says so. */
    if (awakeTimer) clearTimeout(awakeTimer);
    awakeTimer = setTimeout(function () {
      awakeTimer = 0;
      if (!awake || thinking) return;
      if (performance.now() < awakeUntil) return;     // woken again since
      awake = false;
      fire({ kind: 'listening' });
    }, AWAKE_MS + 60);
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

  function askNow(question) {
    if (thinking) return;
    lastSaid = question;
    thinking = true;
    awakeUntil = performance.now() + AWAKE_MS;
    fire({ kind: 'thinking', question: question });

    var shot = CAM.frame ? CAM.frame(768) : null;
    var ctx = context();

    var full = PROMPT + '\n\nWhat the app has already worked out: ' + ctx +
               '\n\nThe question: ' + question;

    var job = GEM.has()
      ? GEM.ask(full, shot, { json: true, maxTokens: 320 })
      : IDENT.post('/v1/ask', { prompt: full, image: shot })
          .then(function (r) { return r && r.ok ? { ok: true, text: r.text, json: null, model: 'worker' } : { ok: false, error: (r && r.error) || 'no answer' }; });

    return job.then(function (r) {
      thinking = false;
      if (!r.ok) {
        lastAnswer = { say: 'I could not reach the assistant.', error: r.error };
        fire({ kind: 'answer', answer: lastAnswer });
        speak(lastAnswer.say);
        return lastAnswer;
      }
      var parsed = r.json;
      if (!parsed) { try { parsed = JSON.parse(pickJson(r.text)); } catch (e) {} }
      var say = (parsed && parsed.say) || r.text || '';
      apply(parsed && parsed.actions);
      lastAnswer = { say: say, actions: (parsed && parsed.actions) || [], model: r.model };
      fire({ kind: 'answer', answer: lastAnswer });
      speak(say);
      return lastAnswer;
    }).catch(function (e) {
      thinking = false;
      lastAnswer = { say: 'Something went wrong asking that.', error: String(e && e.message || e) };
      fire({ kind: 'answer', answer: lastAnswer });
      return lastAnswer;
    });
  }

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

  /* Spoken back, where the browser will. Cancelled first so two answers
     never talk over each other. */
  function speak(text) {
    if (!text || !window.speechSynthesis) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  return { start: start, stop: stop, state: state, on: onEvent, ask: askNow, awakeMs: awakeMs,
           wake: wake, speak: speak, _heard: heard, _apply: apply,
           WAKE: WAKE, ACTIONS: ACTIONS };
})();
