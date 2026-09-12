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

    { name: 'zoom',
      re: /^zoom\s+(in|out)\b/i,
      run: function (m) {
        if (!mapOpen()) return { say: 'The map is not open.' };
        var did = press(/in/i.test(m[1]) ? 'mapZoomIn' : 'mapZoomOut');
        return did ? { say: /in/i.test(m[1]) ? 'Closer.' : 'Wider.' } : false;
      } },

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
