/* Sightline - the things it can do without asking anybody.

   "i want this to be able to be used hands free, so you can say hey vision
    do this or do that with built in voice commands which get checked
    before sent to gemini like show map or select subject n more complex
    commands are handed to gemini."

   So this is tried FIRST, every time, and only what falls through it goes
   to the model. Three reasons, and the first is the one that matters:

     IT WORKS WITH NO SIGNAL AND NO KEY. "Show the map" should not need a
     network, an account, or somebody's quota. Most of what a person says
     to this app is one of thirty things.

     IT IS INSTANT. A round trip is a second or two; this is a regex.

     IT CANNOT MISUNDERSTAND. A model asked to "zoom in" can decide to do
     something else. This cannot do anything that is not written here.

   THE RULE THAT KEEPS IT HONEST: a command presses the control a finger
   would press. It never reaches past the interface to do something the
   interface cannot. So a command can never do more than the app can, and
   a control that is not on screen answers "not now" rather than acting
   invisibly.                                                             */
var CMD = (function () {

  /* Press a real control, the way a finger does. Answers false if it is
     not there or not available, which is a "not now", not a failure. */
  function press(id) {
    var el = document.getElementById(id);
    if (!el || el.hidden || el.disabled) return false;
    if (el.offsetParent === null) return false;                          // not on screen
    el.click();
    return true;
  }
  function mapOpen() { return !!(window.MAP && MAP.isOpen && MAP.isOpen()); }

  /* The layer chips answer to the same four words the map draws with. */
  var LAYERS = { map: 'map', tiles: 'map', street: 'map', streets: 'map', road: 'map', roads: 'map',
                 building: 'map', buildings: 'map',
                 place: 'places', places: 'places', label: 'places', labels: 'places',
                 route: 'route', path: 'route' };

  function setLayer(word, want) {
    var k = LAYERS[String(word || '').toLowerCase()];
    if (!k || !window.MAPVIEW) return false;
    if (!mapOpen()) MAP.setOpen(true);
    var on = !!MAPVIEW.state().layers[k];
    if (on !== want) { if (!press('layer-' + k)) return false; }
    return k;
  }

  /* ---- the table ----

     Order matters: the first match wins, so the specific patterns sit
     above the general ones. Every "say" is what gets read back, because a
     hands-free command with no spoken answer leaves you staring at a
     phone to find out whether it heard you. */
  var TABLE = [

    /* --- navigation, the one the owner asked for by name --- */
    { name: 'directions',
      re: /^(?:start|begin|give me|get me)?\s*(?:directions|navigation|navigate|route|take me|walk me|guide me)\b[^.?]*?\bto\s+(.+)$/i,
      long: true,
      run: function (m) {
        var where = tidy(m[1]);
        if (!where) return false;
        if (!window.MAP || !MAP.searchGo) return false;
        if (!GEO.state().pos) return { say: 'I do not know where you are yet.' };
        return { say: 'Looking for ' + where + '.',
                 then: MAP.searchGo(where).then(function (p) {
                   return p ? { say: 'Heading to ' + p.title + ', ' + human(p.dist) + ' away.' }
                            : { say: 'I could not find ' + where + ' near here.' };
                 }) };
      } },

    { name: 'stop directions',
      re: /^(?:stop|cancel|end|clear)\s+(?:the\s+)?(?:directions|navigation|route|navigating)\b/i,
      run: function () {
        if (!window.MAP || !MAP.dest || !MAP.dest()) return { say: 'You are not navigating.' };
        MAP.setDest(null);
        return { say: 'Directions stopped.' };
      } },

    /* --- the map --- */
    { name: 'close map',
      re: /^(?:close|hide|dismiss|exit|leave)\s+(?:the\s+)?map\b/i,
      run: function () {
        if (!mapOpen()) return { say: 'The map is already closed.' };
        MAP.setOpen(false); return { say: 'Closed.' };
      } },

    { name: 'open map',
      re: /^(?:show|open|bring up|go to|display)\s+(?:me\s+)?(?:the\s+)?map\b/i,
      run: function () { MAP.setOpen(true); return { say: 'Map.' }; } },


    { name: 'follow me',
      re: /^(?:follow me|centre on me|center on me|back to me|find me|where am i)\b/i,
      run: function () {
        if (!mapOpen()) MAP.setOpen(true);
        return press('mapFollow') ? { say: 'Centred on you.' } : false;
      } },

    { name: 'layer',
      re: /^(?:show|hide|turn\s+(?:on|off)|switch\s+(?:on|off))\s+(?:the\s+)?(map|tiles|buildings?|streets?|roads?|places?|labels?|route|path)\b/i,
      run: function (m) {
        var want = !/\b(?:hide|off)\b/i.test(m[0]);
        var k = setLayer(m[1], want);
        return k ? { say: (want ? 'Showing ' : 'Hiding ') + k + '.' } : false;
      } },

    /* --- the camera itself ---

       Said the way people say them. "capture" and "snap" are the same
       thing as "take a photo"; "record" and "start recording" are the
       same thing as "take a video". A number is optional everywhere it
       appears, because "zoom in" is a sentence and so is "zoom in by
       three". */
    /* --- reading a sign --- */
    { name: 'translate view',
      /* Bare "translate" is a sentence, so the noun after it is optional -
         the first cut demanded one and matched nothing on its own. "label"
         is deliberately absent: "read the label" is the barcode scanner's,
         and that command sits further down the table. */
      re: /^translate\b|^read\s+(?:the\s+|this\s+|that\s+)?(?:sign|menu|writing|text|page)\b/i,
      run: function () {
        if (!window.LENS) return false;
        if (!LENS.available()) return { say: 'Reading a sign needs a Gemini key.' };
        if (LENS.running()) return { say: 'Already translating what I can see.' };
        LENS.start();
        return { say: 'Reading it.' };
      } },
    { name: 'stop translating',
      re: /^(?:stop|turn off|cancel)\s+(?:the\s+)?translat(?:ing|ion)\b/i,
      run: function () {
        if (!window.LENS || !LENS.running()) return { say: 'Nothing is being translated.' };
        LENS.stop();
        return { say: 'Stopped.' };
      } },

    { name: 'photo',
      re: /^(?:take|grab|shoot)?\s*(?:a\s+)?(?:photo|picture|photograph|snap|shot)\b|^(?:capture|snap)\b(?!\s+(?:video|clip))/i,
      run: function () {
        if (!window.CAM || !CAM.photo) return false;
        var url = CAM.photo();
        if (!url) return { say: 'The camera is not running.' };
        if (window.UI && UI.showPhoto) UI.showPhoto(url);
        return { say: 'Got it.' };
      } },

    { name: 'stop recording',
      re: /^(?:stop|end|finish)\s+(?:the\s+)?(?:recording|record|video|filming|clip)\b|^stop\s+filming\b/i,
      run: function () {
        if (!window.CAM || !CAM.recording || !CAM.recording()) return { say: 'Nothing is recording.' };
        var secs = Math.round(CAM.recMs() / 1000);
        CAM.stopRec().then(function (clip) {
          if (clip && window.UI && UI.showClip) UI.showClip(clip);
        });
        return { say: 'Stopped. ' + secs + ' second' + (secs === 1 ? '' : 's') + '.' };
      } },

    { name: 'record',
      re: /^(?:take|shoot|start|begin)?\s*(?:a\s+)?(?:video|recording|clip|filming)\b|^(?:record|film)\b/i,
      run: function () {
        if (!window.CAM || !CAM.startRec) return false;
        if (CAM.recording()) return { say: 'Already recording. Say stop recording when you are done.' };
        if (!CAM.canRecord()) return { say: 'This browser will not record video.' };
        return CAM.startRec()
          ? { say: 'Recording. Say stop recording when you are done.' }
          : { say: 'I could not start recording.' };
      } },

    /* ONE ZOOM, AND IT KNOWS WHAT IS BEING ZOOMED.

       There were two - the map's and the camera's - and the map's came
       first and matched "zoom in by three", so a camera zoom answered
       "the map is not open". What a person means by zoom is whatever is
       filling the screen: the map while the map is up, the camera
       otherwise. */
    { name: 'zoom',
      re: /^zoom\s+(?:(in|out)\b\s*)?(?:(?:by|to)\s+)?(?:times\s+)?([\d.]+)?\s*(?:x|times)?\b/i,
      run: function (m) {
        var dir = (m[1] || 'in').toLowerCase();
        var n = m[2] ? parseFloat(m[2]) : null;
        var to = /^zoom\s+to\b/i.test(m[0]);

        if (mapOpen()) {
          /* The map has its own two buttons; a number means that many
             presses of one of them. */
          var times = Math.max(1, Math.min(6, Math.round(n || 1)));
          var id = dir === 'out' ? 'mapZoomOut' : 'mapZoomIn';
          var did = false;
          for (var i = 0; i < times; i++) did = press(id) || did;
          return did ? { say: dir === 'out' ? 'Wider.' : 'Closer.' } : false;
        }

        if (!window.CAM || !CAM.setZoom) return false;
        if (to && n) return { say: zoomWords(CAM.setZoom(n)) };
        var by = (n && isFinite(n) && n > 0) ? n : 2;
        return { say: zoomWords(CAM.zoomBy(dir === 'out' ? 1 / by : by)) };
      } },

    { name: 'reset zoom',
      re: /^(?:reset|clear)\s+(?:the\s+)?zoom\b|^zoom\s+(?:all\s+the\s+way\s+)?out\s+(?:fully|all the way)\b/i,
      run: function () {
        if (!window.CAM || !CAM.setZoom) return false;
        CAM.setZoom(1);
        return { say: 'Back to normal.' };
      } },

    { name: 'flip camera',
      re: /^(?:flip|switch|turn(?:\s+a?round)?|change)\s+(?:the\s+)?camera\b|^(?:selfie|front camera|back camera|rear camera)\b/i,
      run: function (m) {
        var btn = document.getElementById('btnFlip');
        if (!btn) return false;
        /* "front camera" when already on the front is not a flip. */
        var want = /selfie|front/i.test(m[0]) ? 'user' : /back|rear/i.test(m[0]) ? 'environment' : null;
        if (want && window.CAM && CAM.current && CAM.current() === want) {
          return { say: 'Already on that one.' };
        }
        btn.click();
        return { say: 'Switched.' };
      } },

    /* --- the camera --- */
    { name: 'scan',
      re: /^(?:scan|read)\s+(?:the\s+|this\s+|that\s+)?(?:code|barcode|qr code|qr|label|tag)\b|^scan (?:this|it|that)\b/i,
      run: function () {
        if (!window.SCAN) return false;
        SCAN.burst();
        return { say: 'Looking for a code.' };
      } },

    /* "who is that" is the most-asked question this app has, and it used
       to go to the model as free text - a round trip to be told to tap
       the person. It is the same door the tap opens. */
    { name: 'who is that',
      re: /^who(?:'s| is| are)\s+(?:that|this|they|these|he|she|him|her)\b|^name\s+(?:that|this|the)\s+(?:person|actor|man|woman|face)\b/i,
      run: function () {
        if (!window.UI) return false;
        /* The person, not the middle of the picture. Asking "who is that"
           while a face is off to one side used to look up whatever the
           camera happened to be pointed at. The biggest person on screen
           is the one being asked about. */
        var who = biggest('person');
        if (who && UI.openTrack) { UI.openTrack(who); return { say: 'Looking them up.' }; }
        if (!UI.openScene) return false;
        UI.openScene();
        return { say: 'Looking them up.' };
      } },

    { name: 'select subject',
      re: /^(?:select|identify|inspect|look at)\s+(?:the\s+)?(?:subject|thing|object|this|that|it)\b|^what(?:'s| is) (?:this|that)\s*\??$/i,
      run: function () {
        if (!window.UI || !UI.openScene) return false;
        UI.openScene();
        return { say: 'Having a closer look.' };
      } },

    { name: 'clear',
      re: /^(?:clear|reset|show everything|stop highlighting|never mind|forget it)\b/i,
      run: function () { fire({ kind: 'clear' }); return { say: 'Cleared.' }; } },

    { name: 'only',
      re: /^(?:only|just)\s+(?:show|box|keep)?\s*(?:the\s+)?(.+)$/i,
      run: function (m) {
        var what = tidy(m[1]);
        if (!what) return false;
        fire({ kind: 'only', what: what });
        return { say: 'Only the ' + what + '.' };
      } },

    { name: 'box',
      re: /^(?:box|highlight|mark|point (?:at|to))\s+(?:the\s+|a\s+)?(.+)$/i,
      run: function (m) {
        var what = tidy(m[1]);
        if (!what) return false;
        var col = (what.match(/\bin (green|blue|amber|pink|red)\b/i) || [])[1] || '';
        if (col) what = tidy(what.replace(/\bin (green|blue|amber|pink|red)\b/i, ''));
        if (!what) return false;
        fire({ kind: 'box', what: what, colour: col.toLowerCase() });
        return { say: 'Marking the ' + what + '.' };
      } },

    /* --- the app itself --- */
    { name: 'captions',
      re: /^(?:turn\s+(?:on|off)|start|stop|show|hide)\s+(?:the\s+)?(?:captions?|subtitles?)\b/i,
      run: function () {
        return press('btnCaptions') ? { say: 'Captions.' } : false;
      } },

    { name: 'close settings',
      re: /^(?:close|hide|exit|leave)\s+(?:the\s+)?settings\b/i,
      run: function () {
        var el = document.getElementById('settings');
        if (!el || el.hidden) return { say: 'Settings are already closed.' };
        return press('settingsClose') ? { say: 'Closed.' } : false;
      } },

    { name: 'open settings',
      re: /^(?:open|show|go to)\s+(?:the\s+)?settings\b/i,
      run: function () { return press('btnSettings') ? { say: 'Settings.' } : false; } },

    { name: 'what can you do',
      re: /^what can (?:you|i) (?:do|say)\b|^(?:list|show)\s+commands\b|^help\b/i,
      run: function () {
        return { say: 'Try: show the map, directions to the station, zoom in, ' +
                      'hide buildings, scan this code, box the bicycle, or ask me anything.' };
      } }
  ];

  /* The largest thing of a kind currently on screen, or nothing. */
  function biggest(kind) {
    if (!window.TRACK || !window.IDENT || !IDENT.kindOf) return null;
    var best = null, bestArea = 0;
    TRACK.all().forEach(function (t) {
      if (IDENT.kindOf(t.cls) !== kind) return;
      var b = t.box || [];
      var a = (b[2] || 0) * (b[3] || 0);
      if (a > bestArea) { bestArea = a; best = t; }
    });
    return best;
  }

  function tidy(s) {
    return String(s || '')
      .replace(/[.,!?]+\s*$/, '')
      .replace(/\b(?:please|now|for me|thanks|thank you)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim().toLowerCase();
  }
  function human(m) { return m < 1000 ? (m + ' metres') : ((m / 1000).toFixed(1) + ' kilometres'); }
  /* "if x is too big it goes to maximum available zoom" - so it never
     refuses a number, it clamps and says where it landed. */
  function zoomWords(r) {
    if (!r) return 'The camera will not zoom.';
    var at = (Math.round(r.at * 10) / 10) + 'x';
    if (r.at <= r.min + 0.001) return 'Back to normal.';
    if (r.capped && r.at >= r.max - 0.001) return 'As far as it goes, ' + at + '.';
    return at + '.';
  }

  /* Whatever wants to hear about a display change. VOICE hooks this so a
     spoken "box the bike" and a Gemini-driven one go the same way. */
  var listeners = [];
  function on(fn) { listeners.push(fn); }
  function fire(ev) { listeners.forEach(function (f) { try { f(ev); } catch (e) {} }); }

  /* A COMMAND IS A SHORT IMPERATIVE, AND IT STARTS WITH THE VERB.

     Both halves of that were paid for. Without the anchor, "read me the
     label on the blue box and tell me if it has nuts in it" matched the
     scanner - it contains "read" and it contains "label" - so a real
     question was answered by opening the barcode reader. Without the
     length cap, any long sentence beginning with an innocent word gets
     caught the same way.

     The boundary is deliberately blunt: if it is long, it is a question,
     and questions belong to the model. A "directions to ..." can run on,
     because a place name does, so that one is marked and exempt. */
  var MAX_WORDS = 9;
  var LEAD = /^\s*(?:hey|hi|ok|okay)\s+(?:vision|sightline)\b[,: ]*/i;
  var POLITE = /^\s*(?:please|can you|could you|would you|i want you to|i'd like you to)\s+/i;

  function normalise(text) {
    var line = String(text || '').trim();
    line = line.replace(LEAD, '');
    line = line.replace(POLITE, '');
    return line.trim();
  }

  /* Does this line match a built-in? Answers the entry, without running
     it, so a caller can tell "we know this one" from "we did it". */
  function match(text) {
    var line = normalise(text);
    if (!line) return null;
    var words = line.split(/\s+/).length;
    for (var i = 0; i < TABLE.length; i++) {
      if (words > MAX_WORDS && !TABLE[i].long) continue;
      var m = line.match(TABLE[i].re);
      if (m) return { name: TABLE[i].name, m: m, entry: TABLE[i] };
    }
    return null;
  }

  /* Run it. Answers null when nothing here handles the line - which is the
     signal to hand it to the model - or { say, then } when it did.

     A command that finds its door shut answers `false`, and that is also
     null to the caller: better the model has a go than the reader is told
     "no" by a table. */
  function run(text) {
    var hit = match(text);
    if (!hit) return null;
    var out;
    try { out = hit.entry.run(hit.m); }
    catch (e) { return null; }
    if (!out) return null;
    out.name = hit.name;
    return out;
  }

  function names() { return TABLE.map(function (e) { return e.name; }); }

  return { match: match, run: run, on: on, names: names,
           _table: TABLE, _tidy: tidy, _normalise: normalise };
})();
