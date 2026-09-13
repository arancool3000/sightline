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
  /* IN ORDER OF PREFERENCE, NEWEST FIRST.

     Gemini 3 Flash Live is the newest full-dialog model that is unlimited
     on the free tier - unlimited requests a minute and a day, 65K tokens a
     minute, which is ample when a conversation is about 2K a minute each
     way and one camera frame goes up per wake. 2.5 Native Audio Dialog is
     the same deal with a far bigger token budget (1M) and is the one to
     fall back to if the newer ever throttles.

     NOT on this list, deliberately: 3.5 Live Translate and 3.5 Transcribe
     Live. They are unlimited too, and they each do exactly one job -
     translate, or transcribe. Neither holds a conversation or calls a
     command, so putting them here would look like a working assistant
     that ignores everything it is asked to do.

     The ids move and a name that is gone closes the socket rather than
     answering with an error anybody can read, so the list is walked until
     one connects. */
  var MODELS = [
    'models/gemini-3-flash-live',
    'models/gemini-live-2.5-flash-preview',
    'models/gemini-2.5-flash-native-audio-preview-09-2025',
    'models/gemini-2.0-flash-live-001'
  ];
  /* ⚠ v2: the first cut promoted the remembered model to the FRONT, so a
     device that once connected on 2.5 would have stayed on it for ever and
     never tried 3 Flash again - the preference order would have been
     decided once, on whichever day the newest happened to be down. The key
     is bumped so those devices start again. */
  var REMEMBER = 'sightline.live.model.v2';

  /* ---- WHICH MODELS ACTUALLY EXIST ----

     The list above is guesswork, and it showed: on the owner's key the
     first two names did not connect at all and the session fell through
     to the third. Guessing ids from a quota page's display names is not
     something to keep doing - the API will say. ListModels returns every
     model with the methods it supports, and the live ones are exactly
     those carrying bidiGenerateContent. Names found that way are real by
     construction; the hand list stays only for when the lookup itself
     cannot be reached. */
  var LIST = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=';
  var found = null, listing = null;

  /* Newest and most capable first, by what the name says about it. A
     dialog model outranks a transcriber, and a bigger number outranks a
     smaller one. */
  function rank(id) {
    var n = String(id || '');
    if (/translate|transcribe|tts|image|embedding/i.test(n)) return -1;   // not conversation
    var v = 0, m = /gemini-(\d+(?:\.\d+)?)/.exec(n);
    if (m) v = parseFloat(m[1]) * 10;
    if (/native-audio/.test(n)) v += 3;      // the real dialog models
    if (/live/.test(n)) v += 2;
    if (/preview|exp/.test(n)) v -= 1;       // a stable name beats a preview
    return v;
  }

  function discover() {
    if (found) return Promise.resolve(found);
    if (listing) return listing;
    if (!window.GEM || !GEM.has || !GEM.has()) return Promise.resolve(null);
    listing = U.fetchT(LIST + encodeURIComponent(GEM.key()), { headers: { 'Accept': 'application/json' } }, 9000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        listing = null;
        var all = (j && j.models) || [];
        var live = all.filter(function (m) {
          return (m.supportedGenerationMethods || []).indexOf('bidiGenerateContent') >= 0;
        }).map(function (m) { return m.name; })
          .filter(function (n) { return rank(n) >= 0; })
          .sort(function (a, b) { return rank(b) - rank(a); });
        found = live.length ? live : null;
        return found;
      })
      .catch(function () { listing = null; return null; });
    return listing;
  }
  var UP_RATE = 16000, DOWN_RATE = 24000;
  var IDLE_MS = 45000;          // a quiet conversation closes itself
  /* WATCHING, NOT GLANCING.

     One frame was sent when the session woke, so "what about the one next
     to it?" was answered from a photograph taken before the question. A
     frame a second costs about 258 tokens each - 15,500 a minute against
     the 65,000 this model allows, under a quarter - so the session can
     simply keep looking. It stops the moment the session does. */
  var FRAME_MS = 1000;
  var frameTimer = 0;

  var ws = null, model = '', mi = 0, tried = [], order = [];
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
    /* THE PREFERRED MODEL IS ALWAYS TRIED FIRST. What worked last time is
       promoted to SECOND, so a session skips straight past the names that
       failed without ever pinning itself away from the newest one. */
    var last = '';
    try { last = localStorage.getItem(REMEMBER) || ''; } catch (e) {}
    return discover().then(function (real) {
      order = (real && real.length) ? real.slice() : MODELS.slice();
      if (last && order.indexOf(last) > 1) {
        order = [order[0], last].concat(order.slice(1).filter(function (m) { return m !== last; }));
      }
      mi = 0;
      return connect();
    });
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
    if (!order.length) order = MODELS.slice();
    if (mi >= order.length) { connecting = false; err = err || 'no live model answered'; fire({ kind: 'error', error: err }); return Promise.resolve(false); }
    model = order[mi];
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
          tools: [{ functionDeclarations: declarations() }],
          /* Both sides as text, which is what puts the conversation on
             screen: "it should show captions as me and ai talk". */
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: brief() }] }
        } }));
      };

      sock.onmessage = function (m) {
        readFrame(m.data, function (msg) {
          if (msg.toolCall) { toolCall(msg); return; }
    if (msg.setupComplete) {
            if (settled) return;
            settled = true; clearTimeout(giveUp);
            ws = sock; open = true; connecting = false;
            try { localStorage.setItem(REMEMBER, model); } catch (e) {}
            touch();
            fire({ kind: 'open', model: model });
            micOn();
            /* A word on connecting, so the whole path - socket, model,
               audio out, speaker - is proven before anybody has said
               anything, instead of the first failure being discovered
               halfway through a question. */
            say('Say only: ready.');
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

  /* ---- TOOLS, DECLARED PROPERLY ----

     "it doesn't know its tool calls. it literally just did [[do:box the
      rubiks cube]] when i told it to draw a box around the rubiks cube."

     Right, and that is my design being wrong rather than the model being
     stupid. A native-audio model SPEAKS everything it produces, so a text
     marker in its answer is read out loud - it did exactly what it was
     told and the instruction came out of the speaker.

     The Live API has function calling for this. A declared tool comes back
     as a toolCall frame, which is not part of what it says, so nothing is
     spoken. Each one runs through CMD - the same table a finger and a
     spoken command go through - and the phrase is generated FROM this
     table, so the tool and the words it maps to cannot drift apart. */
  var TOOLS = [
    { name: 'show_map',        say: 'show the map',        what: 'Open the full map page so the person can see where they are.' },
    { name: 'close_map',       say: 'close the map',       what: 'Close the map page and go back to the camera view.' },
    { name: 'zoom_in',         say: 'zoom in',             what: 'Zoom the map in to show more detail.' },
    { name: 'zoom_out',        say: 'zoom out',            what: 'Zoom the map out to show more ground.' },
    { name: 'follow_me',       say: 'follow me',           what: 'Recentre the map on where the person is standing.' },
    { name: 'scan_code',       say: 'scan this code',      what: 'Look for a QR code or a barcode in view right now.' },
    { name: 'identify',        say: '\u0000identify',       what: 'Identify the main thing in view exactly - the make, the model, the species, the breed. Call this whenever you are asked what something IS, or told you got it wrong. It asks a model that is better at this than you are and gives you the answer back.' },
    { name: 'stop_directions', say: 'stop directions',     what: 'Stop navigating and put the route away.' },
    { name: 'clear_boxes',     say: 'clear',               what: 'Remove every highlight and box from the view.' },
    { name: 'take_photo',      say: 'take a photo',        what: 'Take a photograph of what the camera can see right now.' },
    { name: 'translate_view',  say: 'translate this sign', what: 'Read the writing in view and lay the translation over it, for a sign or a menu in another language.' },
    { name: 'play_game',       say: 'play the cube game',  what: 'Start the hands-free cube slicing game, played by swinging your hands in front of the camera through a cardboard viewer.' },
    { name: 'stop_game',       say: 'stop the game',       what: 'Leave the game and go back to the camera.' },
    { name: 'stop_translating', say: 'stop translating',   what: 'Stop laying translations over the view.' },
    { name: 'start_recording', say: 'start recording',     what: 'Start recording a video of what the camera can see.' },
    { name: 'stop_recording',  say: 'stop recording',      what: 'Stop the video that is recording and show it.' },
    { name: 'flip_camera',     say: 'flip the camera',     what: 'Switch between the front and back cameras.' },
    { name: 'zoom_to',         say: 'zoom to ',            what: 'Zoom the camera to a factor. Anything larger than the camera allows becomes its maximum.',
      arg: 'times', argWhat: 'How many times to magnify, for example "3".' },
    { name: 'directions_to',   say: 'directions to ',      what: 'Start walking directions to a place.',
      arg: 'place', argWhat: 'Where to go, for example "the post office".' },
    { name: 'box',             say: 'box the ',            what: 'Draw a box around something in view so the person can see which one you mean.',
      arg: 'thing', argWhat: 'What to box, in a word or two, as a person would say it.' },
    { name: 'only',            say: 'only the ',           what: 'Show only this thing and hide the other boxes.',
      arg: 'thing', argWhat: 'What to keep.' }
  ];

  function declarations() {
    return TOOLS.map(function (t) {
      var d = { name: t.name, description: t.what };
      if (t.arg) {
        d.parameters = { type: 'OBJECT', properties: {}, required: [t.arg] };
        d.parameters.properties[t.arg] = { type: 'STRING', description: t.argWhat };
      }
      return d;
    });
  }

  /* A tool call becomes the words the table already understands. */
  function phraseFor(name, args) {
    for (var i = 0; i < TOOLS.length; i++) {
      if (TOOLS[i].name !== name) continue;
      var t = TOOLS[i];
      if (t.say.charAt(0) === '\u0000') return t.say;   // handled here, not by the table
      if (!t.arg) return t.say;
      var v = String((args && args[t.arg]) || '').trim();
      if (!v) return '';
      /* "zoom to 3" is not a sentence the table knows; "zoom to 3x" is. */
      return t.say + v + (t.name === 'zoom_to' ? 'x' : '');
    }
    return '';
  }

  function toolCall(msg) {
    var calls = (msg.toolCall && msg.toolCall.functionCalls) || [];
    if (!calls.length) return;
    var jobs = calls.map(function (c) {
      var phrase = phraseFor(c.name, c.args);
      /* IDENTIFY IS NOT A DISPLAY CHANGE, IT IS A SECOND OPINION.

         "i ask it what 3d printer it is looking at, and it tells me my v3
          plus is from prusa... but when i tap it identification was
          actually correct."

         Same key, different job. The tap path crops to the object and
         asks a reasoning model for an exact make and model; the dialog
         model is looking at a whole room and optimised for answering
         quickly. So the conversation hands identification over rather
         than guessing out loud, and gets the real answer back to say. */
      if (c.name === 'identify') {
        return askTheOtherOne().then(function (name) {
          fire({ kind: 'tool', name: c.name, phrase: 'identify', ok: !!name, answer: name });
          return { id: c.id, name: c.name,
                   response: { result: name || 'could not identify it from here' } };
        });
      }
      var did = phrase && window.CMD ? CMD.run(phrase) : null;
      fire({ kind: 'tool', name: c.name, phrase: phrase, ok: !!did });
      return Promise.resolve({ id: c.id, name: c.name,
                               response: { result: did ? 'done' : 'not available' } });
    });
    /* It waits for these before it carries on talking. */
    Promise.all(jobs).then(function (replies) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ toolResponse: { functionResponses: replies } }));
      }
    });
  }

  /* The biggest thing on screen, through the same door a tap uses. */
  function askTheOtherOne() {
    if (!window.IDENT || !IDENT.tapAsk || !window.TRACK) return Promise.resolve('');
    var best = null, area = 0;
    TRACK.all().forEach(function (t) {
      var b = t.box || [], a = (b[2] || 0) * (b[3] || 0);
      if (a > area) { area = a; best = t; }
    });
    if (!best) return Promise.resolve('');
    return IDENT.tapAsk(best).then(function (rec) {
      if (!rec || !rec.name) return '';
      var bits = [rec.name];
      if (rec.scientific) bits.push('(' + rec.scientific + ')');
      (rec.specs || []).slice(0, 3).forEach(function (s) { if (s && s.k && s.v) bits.push(s.k + ': ' + s.v); });
      return bits.join(' \u00b7 ');
    }, function () { return ''; });
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
           'You have tools for changing what is on the display - boxing something, opening the map, ' +
           'starting directions. CALL them. Never say a tool name or an instruction out loud: everything ' +
           'you say is spoken aloud to the person, so an instruction in your words is heard as gibberish ' +
           'instead of done. Call the tool and then say the ordinary sentence that goes with it.\n' +
           'When you are asked to identify something and you are not certain, call identify - it sends the ' +
           'picture to a model that is better at exact makes and models than you are, and being right ' +
           'matters more than answering first.';
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
          sendAudio(b64(out.buffer));
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
        watch();
        fire({ kind: 'mic' });
      }, function () { err = 'the microphone was refused'; fire({ kind: 'error', error: err }); });
  }

  /* THE FIELD THE AUDIO GOES IN HAS TWO NAMES.

     realtimeInput.mediaChunks is the original; realtimeInput.audio is
     what replaced it. A server that does not know the one you sent
     ignores it and says nothing back - which is exactly "connected but it
     has not answered yet", because from here silence and deafness look
     identical. So the modern shape is used, and if a whole session goes
     by without a single reply the other one is tried on the next
     connection rather than the reader being told it does not work. */
  var LEGACY = 'sightline.live.legacyaudio';
  var legacy = false;
  try { legacy = localStorage.getItem(LEGACY) === '1'; } catch (e) {}

  function sendAudio(data) {
    var chunk = { mimeType: 'audio/pcm;rate=' + UP_RATE, data: data };
    ws.send(JSON.stringify(legacy
      ? { realtimeInput: { mediaChunks: [chunk] } }
      : { realtimeInput: { audio: chunk } }));
  }
  function flipAudioShape() {
    legacy = !legacy;
    try { localStorage.setItem(LEGACY, legacy ? '1' : '0'); } catch (e) {}
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

  /* Kept for a model that will not use the tools: the words are still
     stripped before anything is shown. It cannot un-speak them - that is
     precisely why the tools above exist. */
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
      /* Connected, set up, and silent. The likeliest reason is that the
         audio went in a field this server does not read, so the next
         session sends the other shape. */
      flipAudioShape();
      err = 'the live voice connected but never answered - trying the other audio format next time';
      fire({ kind: 'error', error: why() });
      stop();
    }, PROVE_MS);
  }

  function watch() {
    if (frameTimer) clearInterval(frameTimer);
    frameTimer = setInterval(function () {
      if (!open) { clearInterval(frameTimer); frameTimer = 0; return; }
      if (document.hidden) return;                  // nothing to see
      if (!window.CAM || !CAM.frame) return;
      look(CAM.frame(512));
    }, FRAME_MS);
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
    if (frameTimer) { clearInterval(frameTimer); frameTimer = 0; }
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
           MODELS: MODELS, _order: function () { return order.slice(); },
           TOOLS: TOOLS, _declarations: declarations, _phraseFor: phraseFor, _toolCall: toolCall,
           _rank: rank, _discover: discover, _legacy: function () { return legacy; },
           _flip: flipAudioShape, FRAME_MS: FRAME_MS,
           _handle: handle, _act: act, _stripDo: stripDo, _brief: brief };
})();
