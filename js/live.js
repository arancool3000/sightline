/* Sightline - talking to Gemini, live.

   The owner's own quota page settles the design:

     Gemini 2.5 Flash Native Audio Dialog   Live API   0 / Unlimited
     Gemini 3.5 Transcribe Live             Live API   0 / Unlimited
     Gemini 2.5 Flash TTS                              1 / 3 RPM, 2 / 10 a DAY

   Ten speech requests a day is not a voice assistant. The Live API is
   unlimited on the same free key, and it is the whole conversation in one
   socket: your microphone goes up as audio, the answer comes back as
   audio, and BOTH sides come back as text so they can be put on screen.
   No round trip per sentence, no separate speech call, and it hears the
   end of your sentence itself instead of us guessing with a timer.

   The on-device recogniser keeps the wake word - it costs nothing and
   works offline - and remains the whole assistant when there is no key.

   AUDIO SHAPES, because they are not negotiable and getting one wrong is
   silence rather than an error: what goes UP is 16-bit PCM at 16 kHz,
   mono, little-endian, base64. What comes DOWN is 16-bit PCM at 24 kHz. */
var LIVE = (function () {

  var HOST = 'wss://generativelanguage.googleapis.com/ws/' +
             'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  /* Tried in order: the newest dialog model, then the one the owner's page
     lists today. A name that is gone closes the socket at once, so the
     next is tried rather than the reader being told it does not work. */
  /* The live model ids move, and a name that is gone closes the socket at
     once rather than answering with an error a person could read. So
     several are tried in order and whichever connects wins - and the one
     that DID connect is remembered, so the next session starts there
     instead of walking the list again. */
  var MODELS = [
    'models/gemini-3-flash-live',
    'models/gemini-live-2.5-flash-preview',
    'models/gemini-2.5-flash-native-audio-preview-09-2025',
    'models/gemini-2.0-flash-live-001'
  ];
  var REMEMBER = 'sightline.live.model';
  var UP_RATE = 16000, DOWN_RATE = 24000;
  var IDLE_MS = 45000;          // a quiet conversation closes itself

  var ws = null, model = '', mi = 0, tried = [];
  var lastClose = '', heardBack = 0, proveTimer = 0;
  var ac = null, mic = null, node = null, stream = null, sink = null, out = null;
  var played = 0, playedMs = 0;
  var open = false, connecting = false, lastAt = 0, idleTimer = 0;
  var playAt = 0, sources = [];
  var listeners = [], err = '';
  var youSaid = '', itSaid = '';

  function on(fn) { listeners.push(fn); }
  function fire(ev) { listeners.forEach(function (f) { try { f(ev); } catch (e) {} }); }

  function available() { return !!(window.WebSocket && window.GEM && GEM.has && GEM.has() &&
                                   (window.AudioContext || window.webkitAudioContext) &&
                                   navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
  function running() { return open; }
  /* OPEN IS NOT THE SAME AS WORKING. The socket answers setupComplete
     before the microphone has been granted, and if getUserMedia is refused
     the session sits there connected and deaf. Anything that hands its
     input over to the live session must ask THIS, or a failed microphone
     takes the on-device recogniser down with it and nothing answers at
     all. */
  function healthy() { return !!(open && node && stream); }
  function state() { return { open: open, connecting: connecting, model: model, error: err,
                              you: youSaid, it: itSaid, tried: tried.slice(),
                              close: lastClose, answered: heardBack,
                              audio: ac ? ac.state : 'none', played: played, playedMs: playedMs }; }
  /* What to put in front of a person when it will not talk. Every branch
     names something they can act on rather than "it failed". */
  function why() {
    if (!window.GEM || !GEM.has || !GEM.has()) return 'No Gemini key, so the live voice is off.';
    if (open && !heardBack) return 'Connected to ' + short(model) + ' but it has not answered yet.';
    if (open && heardBack && !played) return 'Live on ' + short(model) + ', answering but sending no audio.';
    if (open) return 'Live on ' + short(model) + ' \u00b7 ' + played + ' clips, ' +
                     Math.round(playedMs / 100) / 10 + 's of speech \u00b7 audio ' + (ac ? ac.state : '?') + '.';
    if (tried.length && !model) return 'No live model would connect. Tried: ' + tried.map(short).join(', ') +
                                       (lastClose ? ' (' + lastClose + ')' : '') + '.';
    if (err) return err;
    return 'Live voice is idle.';
  }
  function short(m) { return String(m || '').replace(/^models\//, ''); }

  /* ---- the socket ---- */

  function start() {
    if (open || connecting) return Promise.resolve(true);
    if (!available()) return Promise.resolve(false);
    connecting = true; err = ''; lastClose = ''; heardBack = 0; tried = [];
    /* AN AUDIO CONTEXT STARTS SUSPENDED, and a suspended one plays
       nothing at all while reporting no error - which is exactly "no
       sound coming". It is created and resumed HERE, inside the tap that
       started this, because a browser only grants that from a gesture and
       the gesture is gone by the time the socket answers. */
    audio();
    /* Whichever model worked last time is tried first. */
    var last = '';
    try { last = localStorage.getItem(REMEMBER) || ''; } catch (e) {}
    if (last && MODELS.indexOf(last) > 0) MODELS = [last].concat(MODELS.filter(function (m) { return m !== last; }));
    mi = 0;
    return connect();
  }

  function audio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ac) {
      try { ac = new AC(); } catch (e) { return null; }
      /* Everything audible goes through one gain, so there is a single
         place that decides whether this app is making a sound. */
      try { out = ac.createGain(); out.gain.value = 1; out.connect(ac.destination); } catch (e) { out = null; }
      /* iOS keeps a context silent until something has actually been
         played from a gesture. One empty buffer is enough to open it. */
      try {
        var s0 = ac.createBufferSource();
        s0.buffer = ac.createBuffer(1, 1, 22050);
        s0.connect(out || ac.destination);
        s0.start(0);
      } catch (e) {}
    }
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    return ac;
  }

  function connect() {
    if (mi >= MODELS.length) { connecting = false; err = err || 'no live model answered'; fire({ kind: 'error', error: err }); return Promise.resolve(false); }
    model = MODELS[mi];
    tried.push(model);
    return new Promise(function (res) {
      var sock;
      try { sock = new WebSocket(HOST + '?key=' + encodeURIComponent(GEM.key())); }
      catch (e) { err = String(e && e.message || e).slice(0, 90); mi++; return res(connect()); }
      var settled = false;
      var giveUp = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch (e) {}
        mi++; res(connect());
      }, 8000);

      sock.onopen = function () {
        sock.send(JSON.stringify({ setup: {
          model: model,
          generationConfig: { responseModalities: ['AUDIO'] },
          /* Both sides as text, which is what puts the conversation on
             screen: "it should show captions as me and ai talk". */
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: brief() }] }
        } }));
      };

      sock.onmessage = function (m) {
        readFrame(m.data, function (msg) {
          if (msg.setupComplete) {
            if (settled) return;
            settled = true; clearTimeout(giveUp);
            ws = sock; open = true; connecting = false;
            try { localStorage.setItem(REMEMBER, model); } catch (e) {}
            touch();
            fire({ kind: 'open', model: model });
            micOn();
            prove();
            res(true);
            return;
          }
          handle(msg);
        });
      };

      sock.onerror = function () { err = 'the live connection failed'; };
      sock.onclose = function (e) {
        lastClose = (e && e.code ? e.code : '?') + (e && e.reason ? ' ' + String(e.reason).slice(0, 70) : '');
        if (!settled) {
          settled = true; clearTimeout(giveUp);
          /* 1007/1008 and friends: this model name is not available on this
             key. Try the next rather than reporting a dead feature. */
          err = 'live: ' + (e && e.code ? e.code : 'closed');
          mi++; return res(connect());
        }
        if (sock !== ws) return;
        stop(true);
      };
    });
  }

  /* A Live frame arrives as a Blob on some engines and a string on others. */
  function readFrame(data, done) {
    if (typeof data === 'string') { try { done(JSON.parse(data)); } catch (e) {} return; }
    if (data && data.text) { data.text().then(function (t) { try { done(JSON.parse(t)); } catch (e) {} }); return; }
    if (data instanceof ArrayBuffer) {
      try { done(JSON.parse(new TextDecoder().decode(data))); } catch (e) {}
    }
  }

  function brief() {
    return 'You are Sightline, a camera the person is wearing. Answer in ONE or TWO short spoken ' +
           'sentences - you are being listened to, not read. Never read a list aloud.\n' +
           'When you are asked about what is in front of them, look at the picture and say what YOU see; ' +
           'do not repeat back labels. If you cannot tell, say so - a wrong name is worse than "I cannot ' +
           'tell from here".\n' +
           /* THE WORDS HAVE TO BE THE ONES THE TABLE KNOWS. The first cut
              invented a terse syntax - [[do:map open]] - and the command
              table understands English, so every instruction it gave was
              silently dropped. These are the phrasings a person says, which
              is the only vocabulary there is. */
           'You can act on the display by putting an instruction at the very end of your answer in double ' +
           'square brackets, and nothing else on that line. Use these words exactly:\n' +
           '[[do:show the map]] [[do:close the map]] [[do:zoom in]] [[do:zoom out]] [[do:follow me]] ' +
           '[[do:scan this code]] [[do:identify the subject]] [[do:directions to THE PLACE]] ' +
           '[[do:stop directions]] [[do:box the THING]] [[do:only the THING]] [[do:clear]]\n' +
           'Use one only when it helps; most answers need none.';
  }

  /* ---- what comes back ---- */

  var turnStart = 0, turnPlayed = 0;
  function handle(msg) {
    touch();
    heardBack++;
    if (proveTimer) { clearTimeout(proveTimer); proveTimer = 0; }
    var sc = msg.serverContent;
    if (!sc) return;

    if (sc.inputTranscription && sc.inputTranscription.text) {
      youSaid += sc.inputTranscription.text;
      fire({ kind: 'you', text: youSaid, partial: true });
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      itSaid += sc.outputTranscription.text;
      fire({ kind: 'it', text: itSaid, partial: true });
    }
    var parts = (sc.modelTurn && sc.modelTurn.parts) || [];
    parts.forEach(function (p) {
      var d = p.inlineData || p.inline_data;
      if (d && d.data) play(d.data, rateOf(d.mimeType || d.mime_type));
    });
    /* The model was cut off mid-sentence because the person spoke: drop
       what is queued so it stops talking over them. */
    if (sc.interrupted) silence();
    if (sc.turnComplete) {
      var said = itSaid;
      act(said);
      var words = stripDo(said);
      /* IT ANSWERED, AND NOTHING CAME OUT.

         Whatever the reason - a device that will not play what we were
         sent, a turn that came back as text only - an answer nobody can
         hear is not an answer. If no audio was played during this turn,
         the device reads it instead. */
      if (words && played === turnPlayed) fire({ kind: 'mute', text: words });
      turnPlayed = played;
      fire({ kind: 'turn', you: youSaid, it: words, spoke: played > turnStart });
      youSaid = ''; itSaid = ''; turnStart = played;
    }
  }

  function rateOf(mime) {
    var m = /rate=(\d+)/.exec(mime || '');
    return m ? (parseInt(m[1], 10) || DOWN_RATE) : DOWN_RATE;
  }

  /* ---- speaking ---- */

  function play(b64, rate) {
    if (!audio()) return;
    var bin = atob(b64), n = bin.length >> 1;
    if (!n) return;
    var buf = ac.createBuffer(1, n, rate);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < n; i++) {
      var v = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16;
      ch[i] = v / 32768;
    }
    var src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(out || ac.destination);
    /* Queued end to end, so a sentence arriving in six pieces is one
       sentence rather than six overlapping ones. */
    var now = ac.currentTime;
    if (playAt < now) playAt = now + 0.04;
    src.start(playAt);
    playAt += buf.duration;
    played++; playedMs += Math.round(buf.duration * 1000);
    sources.push(src);
    src.onended = function () { sources = sources.filter(function (s) { return s !== src; }); };
  }
  function silence() {
    sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
    sources = [];
    playAt = 0;
  }

  /* ---- listening ---- */

  function micOn() {
    if (!audio()) return;
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (s) {
        if (!open) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s;
        mic = ac.createMediaStreamSource(s);
        /* ScriptProcessor is deprecated and it is also the only thing every
           browser here actually has; an AudioWorklet needs a separate file
           and Safari's support arrived later than the floor this app sets. */
        node = ac.createScriptProcessor(4096, 1, 1);
        var ratio = ac.sampleRate / UP_RATE;
        node.onaudioprocess = function (e) {
          if (!open || !ws || ws.readyState !== 1) return;
          var input = e.inputBuffer.getChannelData(0);
          var out = new Int16Array(Math.floor(input.length / ratio));
          for (var i = 0; i < out.length; i++) {
            var v = input[Math.floor(i * ratio)];
            out[i] = Math.max(-1, Math.min(1, v)) * 32767;
          }
          ws.send(JSON.stringify({ realtimeInput: { mediaChunks: [
            { mimeType: 'audio/pcm;rate=' + UP_RATE, data: b64(out.buffer) }
          ] } }));
        };
        mic.connect(node);
        /* ⚠ NOT ac.destination. A ScriptProcessor needs a sink or Safari
           will not run it, but sending the MICROPHONE to the speaker put
           the room into a feedback loop with the browser's own echo
           canceller - which then does its job and clamps everything,
           including the model's voice. That is what "no volume" was. A
           silent sink keeps the node running and makes no sound. */
        sink = ac.createGain(); sink.gain.value = 0;
        node.connect(sink); sink.connect(ac.destination);
        /* The live session owns the microphone while it is up: two
           getUserMedia consumers on one phone is how one of them goes
           silent. The on-device recogniser is released when it closes. */
        try { if (window.CAPS && CAPS.hold) CAPS.hold(true); } catch (e) {}
        fire({ kind: 'mic' });
      }, function () { err = 'the microphone was refused'; fire({ kind: 'error', error: err }); });
  }

  function b64(ab) {
    var b = new Uint8Array(ab), s = '', CH = 0x8000;
    for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    return btoa(s);
  }

  /* A picture, so "what am I looking at" is answered from the scene and
     not from a description of it. Sent only when asked for. */
  function look(dataUrl) {
    if (!open || !ws || ws.readyState !== 1 || !dataUrl) return false;
    var comma = dataUrl.indexOf(',');
    ws.send(JSON.stringify({ realtimeInput: { mediaChunks: [
      { mimeType: 'image/jpeg', data: comma === -1 ? dataUrl : dataUrl.slice(comma + 1) }
    ] } }));
    return true;
  }

  /* Typed, or passed through from the built-in commands. */
  function say(text) {
    if (!open || !ws || ws.readyState !== 1 || !text) return false;
    ws.send(JSON.stringify({ clientContent: {
      turns: [{ role: 'user', parts: [{ text: String(text) }] }], turnComplete: true } }));
    return true;
  }

  /* ---- doing what it says ---- */

  var DO = /\[\[do:([^\]]{1,80})\]\]/gi;
  function stripDo(t) { return String(t || '').replace(DO, '').replace(/\s+/g, ' ').trim(); }
  function act(said) {
    if (!window.CMD) return;
    var m, n = 0;
    DO.lastIndex = 0;
    while ((m = DO.exec(String(said || ''))) && n < 4) {
      n++;
      /* Straight through the table every spoken command goes through, so
         the model cannot reach past what a finger can press. */
      CMD.run(m[1].trim());
    }
  }

  /* ---- staying awake, and not ---- */

  /* CONNECTED IS NOT WORKING, AND SILENCE IS THE WORST WAY TO FAIL.

     "no sound coming, it isn't responding to live messages." A socket
     that opens and then says nothing leaves the assistant deaf AND mute,
     because the live session has taken the microphone. So it has a
     window to prove itself: say something, anything, or it is closed and
     the on-device assistant gets the microphone back - with a line on
     screen saying which model would not answer. */
  var PROVE_MS = 9000;
  function prove() {
    if (proveTimer) clearTimeout(proveTimer);
    proveTimer = setTimeout(function () {
      proveTimer = 0;
      if (!open || heardBack) return;
      err = 'the live voice connected but never answered';
      fire({ kind: 'error', error: why() });
      stop();
    }, PROVE_MS);
  }

  function touch() {
    lastAt = Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      idleTimer = 0;
      if (open && Date.now() - lastAt >= IDLE_MS) stop();
    }, IDLE_MS + 500);
  }

  function stop(fromClose) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    if (proveTimer) { clearTimeout(proveTimer); proveTimer = 0; }
    silence();
    try { if (node) { node.disconnect(); node.onaudioprocess = null; } } catch (e) {}
    try { if (sink) sink.disconnect(); } catch (e) {}
    try { if (mic) mic.disconnect(); } catch (e) {}
    sink = null;
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    node = null; mic = null; stream = null;
    try { if (window.CAPS && CAPS.hold) CAPS.hold(false); } catch (e) {}
    var was = open;
    open = false; connecting = false;
    youSaid = ''; itSaid = '';
    if (!fromClose) { try { if (ws) ws.close(); } catch (e) {} }
    ws = null;
    if (was) fire({ kind: 'closed' });
  }

  return { start: start, stop: stop, say: say, look: look, on: on, why: why,
           available: available, running: running, healthy: healthy, state: state,
           MODELS: MODELS, _handle: handle, _act: act, _stripDo: stripDo, _brief: brief };
})();
