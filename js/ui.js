/* Sightline - everything that draws.

   The design is a heads-up display: thin lines, one accent, monospace for
   anything that is data. Labels are bracketed targets with a leader line to
   a plate, not chat bubbles floating over the scene.

   Everything here works with NO endpoint configured. On-device labels are
   real answers and resolve real encyclopedia pages, because Wikipedia and
   Wikidata are keyless. The cloud tier only ever sharpens what is already
   on screen. */
'use strict';

var UI = (function () {

  var cv, ctx, dpr = 1, needsDraw = true;
  var sheet, sheetBody, settings;
  var openTrackId = null;

  function init() {
    cv = U.$('#overlay');
    ctx = cv.getContext('2d');
    sheet = U.$('#sheet');
    sheetBody = U.$('#sheetBody');
    settings = U.$('#settings');
    AR.init();
    MAP.init();
    VOICE.on(voiceEvent);
    if (SET.get('voice')) startVoice();
    SCAN.on(function (hit) {
      showCode(hit);
      status('', '');
    });
    var cx = U.$('#codeClose');
    if (cx) cx.addEventListener('click', hideCode);
    GEO.on(ambient);
    ambient(GEO.state());
    startBattery();
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });
    wire();
    buildSettings();
    startClock();
  }

  function resize() {
    if (!cv) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsDraw = true;
  }

  function dirty() { needsDraw = true; }

  /* ---------- telemetry ---------- */

  function startClock() {
    function tick() {
      var d = new Date();
      var v = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var el = U.$('#tClock');
      if (el && el.textContent !== v) el.textContent = v;   // guarded: this runs forever
    }
    tick();
    setInterval(tick, 10000);
  }

  /* One shared writer so no readout ever repaints without changing. */
  function tele(id, value) {
    var el = U.$(id);
    if (el && el.textContent !== value) el.textContent = value;
  }

  /* ---------- overlay ---------- */

  var COLOR = {
    person: '#8ab4ff', animal: '#ff8fd0', plant: '#5ddc8c',
    insect: '#ffb347', vehicle: '#ff9f6b', object: '#4fe3ff'
  };

  /* draw() always draws. Deciding HOW OFTEN to paint is the loop's job, not
     this function's - a cap in here also swallowed the draws that follow a
     real change, which is the one case that must never be skipped. */
  function draw(all) {
    if (!ctx) return;
    /* Duplicates are suppressed by the tracker, not here: a backpack scored
       twice used to get two cards saying "Backpack", and one tree spanning
       three grid regions got three different names at once. */
    var tracks = (TRACK.visible ? TRACK.visible() : all);
    var w = cv.clientWidth, h = cv.clientHeight;
    var now = performance.now();
    ctx.clearRect(0, 0, w, h);

    /* Plotted / scanned counter, so the sweep is legible as a process. */
    var plotted = tracks.length;
    var settled = 0;
    tracks.forEach(function (t) { if (t.scan === 'relevant' || t.scan === 'dismissed') settled++; });
    tele('#tTgt', plotted ? settled + '/' + plotted : '--');
    statusFromEngine();
    AR.begin();

    tracks.forEach(function (t) {
      var s = CAM.toScreen(t.box);
      var kind = IDENT.kindOf(t.cls);
      var col = COLOR[kind] || COLOR.object;
      /* A marked object and a LABELLED object are different things now: the
         mark says "this is a thing and you can tap it", the label says
         something you did not already know. */
      var named = AR.worthSaying(t);

      /* The voice asked for one thing to be pointed at. Everything else
         either dims or, if it said "only", goes. */
      if (voiceLive()) {
        var hit = voiceMatches(t);
        if (!hit && voiceFocus.only) return;
        if (hit && voiceFocus.colour && VOICE_COLOURS[voiceFocus.colour]) col = VOICE_COLOURS[voiceFocus.colour];
        ctx.globalAlpha = hit ? 1 : 0.28;
      }

      var x = s[0], y = s[1], bw = s[2], bh = s[3];
      /* Was 24px, which threw away most objects in a cluttered scene. A small
         target still gets its marker; only the plate needs room. */
      if (bw < 12 || bh < 12) return;

      /* Skip anything barely in frame: a plate with its leader line running
         off the edge reads as a glitch, not as instrumentation. */
      var vx = Math.max(0, Math.min(x + bw, w) - Math.max(x, 0));
      var vy = Math.max(0, Math.min(y + bh, h) - Math.max(y, 0));
      if (vx * vy < bw * bh * 0.35) return;

      /* A dismissed target has said what it needed to; stop drawing it after
         a moment so the screen does not fill with rejections. */
      if (t.scan === 'dismissed' && t.settled && (now - t.settled) > 2600) return;

      /* A BOX IS NOT A LABEL, AND IT COMES FIRST.

         "make it prioritise drawing boxes around found objects instead of
          just naming them in the bottom."

         Right: finding something and naming something are different
         claims, and the first one is worth showing on its own. Every
         detected object is drawn around, whether or not anything has
         earned the right to name it - so the screen shows what the camera
         has picked out even while the naming is still being decided. */
      var c = Math.min(22, bw * 0.3, bh * 0.3);
      var dismissed = t.scan === 'dismissed' && !named;
      var scanning = (t.scan === 'scanning' || t.state === 'queued') && !named;

      ctx.save();
      ctx.strokeStyle = dismissed ? 'rgba(230,236,241,.5)' : col;
      /* Unnamed does not mean faint. The bracket is the app saying "there
         is a thing there", which is true and useful by itself. */
      ctx.lineWidth = named ? 2 : 1.6;
      ctx.globalAlpha = named ? 0.95 : dismissed ? 0.4 : 0.8;
      if (dismissed) ctx.setLineDash([3, 4]);
      [[x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1]]
        .forEach(function (p) {
          ctx.beginPath();
          ctx.moveTo(p[0] + c * p[2], p[1]);
          ctx.lineTo(p[0], p[1]);
          ctx.lineTo(p[0], p[1] + c * p[3]);
          ctx.stroke();
        });
      ctx.setLineDash([]);

      /* THE MARKER. A label floating near a thing is not AR; a mark ON the
         thing is. Every target gets a dot at its centre and, once named, a
         faint wash over its area, so several objects can be identified at
         once and each answer is unambiguously attached to its subject. */
      var mx = x + bw / 2, my = y + bh / 2;

      if (named) {
        /* Highlight the thing itself: a soft wash plus a glowing outline, so
           it is obvious WHICH object in a busy frame the card belongs to. */
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = col;
        ctx.fillRect(x, y, bw, bh);
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.4;
        ctx.shadowColor = col;
        ctx.shadowBlur = 10;
        ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.95;
      }

      ctx.globalAlpha = dismissed ? 0.35 : 1;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(mx, my, named ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      if (named) {
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(mx, my, 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = named ? 0.95 : dismissed ? 0.3 : scanning ? 0.75 : 0.5;

      ctx.restore();

      /* A target is not simply labelled or blank. It is PLOTTED, then
         SCANNING, then given a verdict - relevant or dismissed with a
         reason. Showing the rejection is the point: it is visible that the
         thing was considered, not overlooked. */
      /* A label from the device is PROVISIONAL - it can only be a generic
         noun. It is shown dimmed with a trailing mark while the specific
         identity is still being fetched, and only a cloud answer (a real
         model name) is presented as settled. */
      var provisional = named && t.tier !== 'cloud' && SET.hasApi() && t.state !== 'done';
      var text;
      if (named) text = t.label + (provisional ? ' …' : '');
      else if (t.scan === 'scanning' || t.state === 'queued') text = 'SCANNING';
      else if (t.scan === 'dismissed') text = t.why || 'DISMISSED';
      else text = String(t.cls).toUpperCase();
      if (t.state === 'skipped' && kind === 'person' && !named) text = 'PERSON';
      text = String(text).toUpperCase();

      /* THE CARD. Canvas is a poor way to draw an icon beside two weights of
         type, so the card is a DOM element that AR moves with a transform;
         the canvas keeps the geometry. place() answers where the card ended
         up so the leader line can be drawn to it. */
      var anchor = AR.place(t, s, kind, w);
      if (anchor) {
        ctx.save();
        ctx.strokeStyle = col;
        ctx.globalAlpha = named ? 0.7 : 0.34;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(anchor[0], anchor[1]);
        ctx.stroke();
        ctx.restore();
      }
    });

    drawFaces(ctx, w, h);
    navArrows(ctx, w, h);
    AR.sweep();
    needsDraw = false;
  }

  /* ---------- walking directions, in the camera ----------

     The owner's design, and it is better than what was here: an arrow that
     points straight at the destination points through walls. These lie
     along the ROAD, round its curve, to the end of it - and when that end
     is reached they recalibrate onto the next road of the route.

     The road is real geometry from OpenStreetMap, so a curved street gets
     curved arrows. Each point of the road ahead is put on the ground plane
     the same way the map puts buildings there: known bearing, known
     distance, camera at chest height, ground assumed flat. That is enough
     to lay a chevron on the pavement without any depth sensing at all. */
  var navPlanAt = 0, navPlanned = null;
  /* The corners of the chevrons drawn last frame, in screen pixels. Kept
     so the shape they make can be measured rather than eyeballed - the
     "diagonal" fault was invisible to a test that only counted ink. */
  var navShapes = [];

  function navArrows(ctx, w, h) {
    if (!window.MAP || !MAP.dest) return;
    var dest = MAP.dest();
    if (!dest) { document.body.classList.remove('navigating'); ROUTE.clear(); navPlanned = null; navShapes = []; return; }
    var st = GEO.state();
    if (!st.pos) return;
    document.body.classList.add('navigating');

    /* Re-plan when the destination changes, when there is no route, or
       every so often as more of the map arrives. */
    var now = performance.now();
    if (navPlanned !== dest || !ROUTE.get() || (now - navPlanAt) > 12000) {
      navPlanAt = now;
      navPlanned = dest;
      ROUTE.plan([st.pos.lat, st.pos.lon], [dest.lat, dest.lon]);
    }

    var f = ROUTE.follow([st.pos.lat, st.pos.lon]);
    if (!f) { navShapes = []; navBearing(ctx, w, h, st, dest); return; }   // no road data yet
    if (typeof st.heading !== 'number') { navLabel(ctx, w, h, 'Turn until the arrows appear'); return; }

    /* The road ahead, as points on the ground in front of the camera. */
    var mPerLat = 111320, mPerLon = 111320 * Math.cos(st.pos.lat * Math.PI / 180);
    var head = st.heading * Math.PI / 180;
    var horizon = h * 0.5;

    function onGround(pt) {
      var dN = (pt[0] - st.pos.lat) * mPerLat;
      var dE = (pt[1] - st.pos.lon) * mPerLon;
      var right = dE * Math.cos(head) - dN * Math.sin(head);
      var fwd = dE * Math.sin(head) + dN * Math.cos(head);
      if (fwd < 1.5) return null;                    // beside or behind you
      /* Chest height, roughly, over a flat pavement. */
      var eye = 1.5, focal = h * 0.62;
      return { x: w / 2 + (right / fwd) * focal,
               y: horizon + (eye / fwd) * focal,
               d: fwd, r: right };
    }

    /* Walk the road ahead at even spacing so the chevrons are evenly spread
       whatever shape the street is. */
    var line = f.ahead;
    var placed = [], walked = 0, want = 6, step = Math.max(5, Math.min(18, f.legLeft / want));
    var target = step;
    for (var i = 1; i < line.length && placed.length < want; i++) {
      var segLen = ROUTE.metres(line[i - 1], line[i]);
      while (walked + segLen >= target && placed.length < want) {
        var t = (target - walked) / (segLen || 1);
        var pt = [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
                  line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
        placed.push({ pt: pt, along: target });
        target += step;
      }
      walked += segLen;
    }

    /* ---- the chevrons are ON THE GROUND, not stuck to the screen ----

       "arrows look strange... diagonal..."

       They were a flat glyph drawn in screen space and rotated by
       atan2(g1.y - g0.y, g1.x - g0.x) - an angle measured in PIXELS. The
       perspective divide squashes vertical differences far harder than
       horizontal ones, so the moment you are not standing exactly on the
       road's centreline the x term dominates and the angle swings toward
       the horizontal. Hence diagonal. And an unsquashed glyph reads as a
       sign floating in the air rather than a marking on the pavement.

       So each chevron is now three corners measured in METRES on the road
       - tip ahead, two tails back and out to either side - and every
       corner goes through the same projection as everything else. The
       direction comes from the road's own geometry, and the foreshortening
       comes out of the projection instead of being faked. */
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    var drew = 0;
    navShapes = [];
    for (var k = 0; k < placed.length; k++) {
      var here = placed[k].pt;
      var nextPt = placed[k + 1] ? placed[k + 1].pt : line[line.length - 1];

      /* Which way the road runs here, in metres north and east. */
      var uN = (nextPt[0] - here[0]) * mPerLat, uE = (nextPt[1] - here[1]) * mPerLon;
      var uLen = Math.sqrt(uN * uN + uE * uE);
      if (uLen < 0.01) continue;                     // two points on top of each other
      uN /= uLen; uE /= uLen;
      var vN = -uE, vE = uN;                         // across the road

      /* Road markings are stretched with distance for exactly this reason:
         a shape that is square on the ground is a sliver at fifty metres.
         These grow the same way, so a far one is still readable without
         leaving the ground. */
      var d = Math.max(2, ROUTE.metres([st.pos.lat, st.pos.lon], here));
      var L = 1.7 + d * 0.10, W = 2.0 + d * 0.035;

      function ground(mF, mR) {
        return onGround([ here[0] + (uN * mF + vN * mR) / mPerLat,
                          here[1] + (uE * mF + vE * mR) / mPerLon ]);
      }
      var tip = ground(L * 0.62, 0),
          tl  = ground(-L * 0.38, -W / 2),
          tr  = ground(-L * 0.38, W / 2);
      if (!tip || !tl || !tr) continue;              // any corner behind you

      var fade = Math.max(0.18, 1 - (k / want));
      var wide = Math.max(2.5, Math.min(11, 44 / tip.d));
      drew++;
      navShapes.push({ tip: [tip.x, tip.y], left: [tl.x, tl.y], right: [tr.x, tr.y], d: tip.d });

      ctx.globalAlpha = fade * 0.35;
      ctx.strokeStyle = 'rgba(0,0,0,.9)';
      ctx.lineWidth = wide * 1.5;
      chevron(ctx, tl, tip, tr);
      ctx.globalAlpha = fade * 0.95;
      ctx.strokeStyle = '#4fe3ff';
      ctx.lineWidth = wide;
      chevron(ctx, tl, tip, tr);
    }
    ctx.restore();

    /* What road, how far, and what happens at the end of it. */
    var txt;
    if (f.arrived) txt = 'You have arrived · ' + dest.title;
    else if (f.next && f.turn) txt = 'Then ' + f.turn + (f.next.name ? ' into ' + f.next.name : '');
    else txt = (f.leg.name || 'Follow the road') + '  ' + fmtM(f.legLeft);
    if (!drew && !f.arrived) txt = (f.turn === 'back' ? 'Turn around · ' : 'Turn until the arrows appear · ') + txt;
    navLabel(ctx, w, h, txt, fmtM(f.remaining) + ' to go');
  }

  /* Three points that are already on the screen, because they were already
     on the ground. Nothing here knows which way is up. */
  function chevron(ctx, a, tip, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function fmtM(m) { return m < 1000 ? (m + ' m') : ((m / 1000).toFixed(1) + ' km'); }

  /* No road data for here yet - fall back to the direction, and say that is
     what it is rather than pretending to know the streets. */
  function navBearing(ctx, w, h, st, dest) {
    if (typeof st.heading !== 'number') return;
    var rel = ((GEO.bearing(st.pos, dest) - st.heading) + 540) % 360 - 180;
    var left = rel * Math.PI / 180;
    var behind = Math.abs(rel) > 100;
    var horizon = h * 0.52;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (var i = 0; i < (behind ? 1 : 5); i++) {
      var t = i / 5;
      var y = h * 0.94 - (h * 0.94 - horizon) * (0.18 + t * 0.72);
      var depth = 1 - t;
      var size = (h * 0.055) * (0.45 + depth * 0.75);
      var x = w / 2 + Math.sin(left) * (w * 0.34) * (1 - depth) +
              (behind ? (rel > 0 ? w * 0.3 : -w * 0.3) : 0);
      ctx.globalAlpha = (0.92 - t * 0.5) * 0.35;
      ctx.strokeStyle = 'rgba(0,0,0,.9)';
      ctx.lineWidth = Math.max(4, size * 0.44);
      chevron(ctx, x, y, size, -Math.PI / 2);
      ctx.globalAlpha = 0.92 - t * 0.5;
      ctx.strokeStyle = '#4fe3ff';
      ctx.lineWidth = Math.max(3, size * 0.34);
      chevron(ctx, x, y, size, -Math.PI / 2);
    }
    ctx.restore();
    var d = Math.round(GEO.metres(st.pos, dest));
    navLabel(ctx, w, h,
      (behind ? (rel > 0 ? 'Turn right · ' : 'Turn left · ') : '') + dest.title + '  ' + fmtM(d),
      'Direct line - no street data here yet');
  }

  function navLabel(ctx, w, h, txt, sub) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 13px -apple-system,system-ui,sans-serif';
    var tw = ctx.measureText(txt).width;
    var sw = 0;
    if (sub) { ctx.font = '500 10.5px -apple-system,system-ui,sans-serif'; sw = ctx.measureText(sub).width; }
    var bw = Math.min(w - 28, Math.max(tw, sw) + 28);
    var bh = sub ? 46 : 30;
    var by = h * 0.955 - (sub ? 8 : 0);
    ctx.fillStyle = 'rgba(6,9,12,.74)';
    roundRect(ctx, w / 2 - bw / 2, by - bh / 2, bw, bh, 15);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,190,255,.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#e6ecf1';
    ctx.font = '600 13px -apple-system,system-ui,sans-serif';
    ctx.fillText(txt, w / 2, by - (sub ? 9 : 0));
    if (sub) {
      ctx.fillStyle = 'rgba(230,236,241,.62)';
      ctx.font = '500 10.5px -apple-system,system-ui,sans-serif';
      ctx.fillText(sub, w / 2, by + 11);
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Show what the recogniser is doing whenever that is not simply "working".
     An empty screen and a broken engine looked identical before this, which
     is how several rounds went by with nothing to diagnose from. */
  var lastStatus = '';
  function status(msg, cls) {
    var strip = U.$('#statusStrip');
    if (!strip) return;
    msg = String(msg == null ? '' : msg).trim();
    var key = cls + '|' + msg;
    if (key === lastStatus) return;          // guarded: this runs every frame
    lastStatus = key;
    /* An empty strip is a black bar that explains nothing and covers the
       scene - it appeared on the owner's device and in a rendering here.
       Hiding CLEARS the text too, so a stale message can never be revealed
       by a later show. */
    if (!msg) {
      U.$('#statusText').textContent = '';
      strip.hidden = true;
      return;
    }
    U.$('#statusText').textContent = msg;
    strip.className = cls || '';
    strip.hidden = false;
  }

  /* Every failure message carries the build and how many lifecycle events the
     recogniser recorded. A screenshot then identifies its own version, and a
     trace of zero is conclusive proof of a stale cached page rather than a
     code fault - which cost several rounds to work out by hand. */
  function stamp() {
    var b = window.KH_BUILD || { sha: '?' };
    var n = (window.LOCAL && LOCAL.trace) ? LOCAL.trace().length : -1;
    return ' [' + b.sha + ' t' + n + ']';
  }

  /* Which tier is doing the work, said honestly.

     LOCAL     no endpoint - device only, which can only give a generic noun
     CLOUD ..  an endpoint is set but nothing has come back from it yet
     CLOUD     at least one specific answer has actually arrived
     CLOUD X   it is being called and it is failing                        */
  var toldCloud = false;
  function engineLine() {
    if (!SET.hasApi()) { tele('#tEng', 'LOCAL'); return; }
    var h = (window.IDENT && IDENT.health) ? IDENT.health() : null;
    if (!h || !h.sent) { tele('#tEng', 'CLOUD'); return; }
    if (h.ok) { tele('#tEng', 'CLOUD'); return; }
    if (h.failed >= 2) {
      tele('#tEng', 'CLOUD X');
      if (!toldCloud) {
        toldCloud = true;
        U.toast('The detail service is not answering (' + h.lastError +
                '). Names stay generic until it does. Tap CFG to test it.', 6500);
      }
      return;
    }
    tele('#tEng', 'CLOUD \u2026');
  }

  function statusFromEngine() {
    engineLine();
    if (!window.LOCAL || !LOCAL.state) return;
    var st = LOCAL.state();
    if (st.code === 'ready') { status('', ''); return; }
    if (st.code === 'loading') { status('LOADING RECOGNISER — FIRST RUN DOWNLOADS ~6MB', 'busy'); return; }
    if (st.code === 'retrying') {
      status('RECOGNISER RETRYING (' + (st.attempt || 1) + '/4) — ' + (st.detail || 'unknown') + stamp(), 'bad');
      return;
    }
    if (st.code === 'erroring') { status('RECOGNISER ERRORING — ' + (st.detail || 'unknown') + stamp(), 'bad'); return; }
    status('RECOGNISER FAILED — ' + (st.detail || 'unknown') + stamp() + ' — CFG > CLEAR CACHE & RESTART', 'bad');
  }

  /* ---------- dossier ---------- */

  function showSheet(html) { sheetBody.innerHTML = html; pruneHero(sheetBody); sheet.hidden = false; }
  function closeSheet() { sheet.hidden = true; openTrackId = null; }

  var SPEC_ORDER = [/manufacturer|maker|brand/i, /^model/i, /released|launched|year/i,
                    /price|cost|from\b/i, /where to buy|retail|stockist|buy/i];
  function orderSpecs(rows) {
    var rank = function (r) {
      for (var i = 0; i < SPEC_ORDER.length; i++) if (SPEC_ORDER[i].test(r.k || '')) return i;
      return SPEC_ORDER.length;
    };
    return rows.slice().map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b) { return (rank(a.r) - rank(b.r)) || (a.i - b.i); })
      .map(function (x) { return x.r; });
  }

  function grid(pairs) {
    var live = pairs.filter(function (p) { return p[1]; });
    if (!live.length) return '';
    return '<dl class="d-grid">' + live.map(function (p) {
      return '<div><dt>' + U.esc(p[0]) + '</dt><dd>' + U.esc(p[1]) + '</dd></div>';
    }).join('') + '</dl>';
  }

  function linkBtn(href, label, acc) {
    if (!href) return '';
    return '<a class="obtn' + (acc ? ' acc' : '') + '" target="_blank" rel="noopener noreferrer" href="' +
      U.esc(href) + '">' + U.esc(label) +
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M8 7h9v9"/></svg></a>';
  }

  function openPending(msg) {
    showSheet('<div class="d-kicker">ANALYSING</div>' +
      '<h3 class="d-title">' + U.esc(msg) + '</h3>' +
      '<div class="skel" style="width:86%"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:78%"></div>');
  }

  function openError(why) {
    var human = /no-endpoint/.test(why)
        ? 'No analysis endpoint is set, so only on-device identification is available. That works with no key and no limit, but it cannot name a specific make and model. Add a Worker in CONFIG for that.'
      : /quota|429/.test(why) ? 'The optional cloud tier is rate limited right now. On-device labelling is unaffected and keeps working.'
      : /Failed to fetch|NetworkError/i.test(why) ? 'Could not reach the analysis endpoint. On-device labelling still works.'
      : 'Nothing could be identified there. Try getting closer, or steadier light.';
    /* No second CLOSE here. The one that used to sit in the body carried an
       inline onclick, which this site's own CSP blocks (script-src has no
       'unsafe-inline'), so it rendered brighter than the real control in the
       corner and did nothing at all. The corner CLOSE is the only one. */
    showSheet('<div class="d-kicker">NO RESULT</div><h3 class="d-title">Not identified</h3>' +
      '<p class="d-body">' + U.esc(human) + '</p>');
  }

  function needEndpoint() { openError('no-endpoint'); }

  /* The honest explanation when the person gate refused a name. */
  function gatedPerson(rec) {
    var why;
    if (rec.gated === 'deceased') {
      var who = rec.deceasedName ? U.esc(rec.deceasedName) : 'a historical figure';
      var yr = rec.diedYear ? ' (died ' + U.esc(String(rec.diedYear)) + ')' : '';
      why = 'The closest match online was <b>' + who + '</b>' + yr +
            ', who is no longer alive &mdash; so this is a resemblance, not that person. ' +
            'Sightline only labels living people, which is what stops a lookalike being named.';
    } else if (rec.gated === 'no-article' || rec.gated === 'not-a-person') {
      why = 'No strong match to a public figure with a Wikipedia page, so no name is shown.';
    } else if (rec.gated === 'faces-off') {
      why = 'Naming people is switched off in CONFIG.';
    } else {
      why = 'The match was not confident enough to put a name on screen.';
    }
    return '<div class="d-kicker">PERSON</div><h3 class="d-title">Not identified</h3>' +
      '<p class="d-body">' + why + '</p>' +
      '<p class="d-note">Private individuals are never identified. Only notable people who already have a public encyclopedia entry can ever be matched.</p>';
  }

  function record(rec) {
    if (!rec) return '<p class="d-body">Nothing came back.</p>';
    if (rec.kind === 'person' && (!rec.name || rec.gated)) return gatedPerson(rec);

    var kicker = (IDENT.KICKER[rec.kind] || 'Object').toUpperCase();
    if (!rec.name) {
      return '<div class="d-kicker">' + U.esc(kicker) + '</div>' +
        '<h3 class="d-title">Not identified</h3>' +
        '<p class="d-body">The match was below your confidence floor. Lower it in CONFIG to see weaker guesses.</p>';
    }

    var w = rec.wiki || {};
    var html = '<div class="d-kicker">' + U.esc(kicker) +
               (rec.source === 'on-device' ? ' / ON-DEVICE'
                : rec.source === 'on-device species' ? ' / ON-DEVICE, ' + rec.kind.toUpperCase() + ' MODEL'
                : rec.source === 'workers-ai' ? ' / WORKERS AI' : '') +
               '</div>';
    html += '<h3 class="d-title">' + U.esc(rec.name) + '</h3>';
    if (rec.scientific) html += '<p class="d-sci">' + U.esc(rec.scientific) + '</p>';
    /* No confidence bar. A number beside an answer that might be wrong does
       not make it less wrong, and the owner asked for them gone. */
    if (w.thumb) html += '<div class="d-hero" data-hero><img src="' + U.esc(w.thumb) + '" alt="" loading="lazy"></div>';

    /* Model-supplied specs come first for objects - that is the whole point
       of pointing a camera at a 3D printer or a robot. */
    if (rec.specs && rec.specs.length) {
      /* What someone pointing a camera at a backpack wants is the maker, the
         exact model, the price and where to get one - in that order, at the
         top. Anything the model was unsure of is simply absent: an omitted
         row is the honest answer, an invented price is not. */
      html += grid(orderSpecs(rec.specs).map(function (s) { return [s.k, s.v]; }));
    }

    if (rec.kind === 'person') {
      html += grid([
        ['Known for', (w.occupations || []).slice(0, 3).join(', ')],
        ['Born', w.bornYear ? String(w.bornYear) : '']
      ]);
    } else if (rec.kind === 'plant' || rec.kind === 'animal' || rec.kind === 'insect') {
      /* Everything Wikidata will say about the species, which is the part of
         this that is genuinely uncapped. grid() drops any row with no value,
         so a taxon it knows little about simply shows less. */
      html += grid([
        ['Also called', w.common],
        ['Rank', w.rank],
        ['Belongs to', w.parent],
        ['Status', w.conservation]
      ]);
    } else if (!rec.specs || !rec.specs.length) {
      html += grid([['Made by', w.maker], ['Since', w.from]]);
    }

    var body = w.extract || rec.note || '';
    if (body) html += '<p class="d-body">' + U.esc(body.slice(0, 520)) + (body.length > 520 ? '…' : '') + '</p>';

    if (rec.source === 'on-device') {
      html += '<p class="d-note flat">Recognised entirely on your device &mdash; no network, no account, no limit. ' +
              'An analysis endpoint can name an exact make and model, but is never required.</p>';
    }

    html += '<div class="d-actions">';
    html += linkBtn(w.url, 'WIKIPEDIA', true);
    html += linkBtn(w.website, 'OFFICIAL SITE');
    html += '</div>';

    if (rec.alt && rec.alt.length) {
      /* When the model could not separate its top answers, the list IS the
         answer: a crossbreed is not in its vocabulary, so the breeds it
         resembles is the most truthful thing that can be said. */
      var torn = typeof rec.margin === 'number' && rec.margin < 0.18;
      html += torn
        ? '<p class="d-note">It could not separate these, which usually means the subject is not in its ' +
          'vocabulary at all - a crossbreed or a cultivar, say. It resembles: ' +
          U.esc([rec.name].concat(rec.alt.slice(0, 3)).join(' / ')) + '</p>'
        : '<p class="d-note">Also possible: ' + U.esc(rec.alt.slice(0, 3).join(' / ')) + '</p>';
    }
    if (!w.url) html += '<p class="d-note">No encyclopedia page matched this one, so the description comes from the model and is less reliable.</p>';
    return html;
  }

  function openRecord(rec) { showSheet(record(rec)); }

  function openTrack(t) {
    openTrackId = t.id;
    if (t.state === 'done' && t.data) { showSheet(record(t.data)); return; }

    /* An on-device label is a real answer: resolve its page straight from
       Wikipedia, which needs no key and no endpoint. */
    if (t.local && t.state !== 'queued') {
      openPending(t.local.name);
      IDENT.fromLocal(t).then(function (rec) {
        if (openTrackId === t.id) showSheet(record(rec));
      });
      if (t.state === 'skipped' || !SET.hasApi()) return;
    }

    if (t.state === 'queued') { openPending('Identifying ' + U.titleCase(t.cls) + '…'); return; }
    if (t.state === 'skipped' && t.reason === 'faces-off') { showSheet(gatedPerson({ kind: 'person', gated: 'faces-off' })); return; }
    if (t.state === 'failed' && !t.local) { openError(t.reason || ''); return; }

    t.state = 'new';
    IDENT.forTrack(t);
    openPending('Identifying ' + U.titleCase(t.cls) + '…');
  }

  /* A picture that will not load leaves a black box with corner marks on it,
     which is worse than no picture: half the things scanned showed one. The
     URL existing is not the same as the image arriving, so the box is taken
     out when it does not. CSP forbids inline handlers, hence the listener. */
  function pruneHero(root) {
    var hero = root && root.querySelector('[data-hero]');
    if (!hero) return;
    var img = hero.querySelector('img');
    if (!img) { hero.parentNode.removeChild(hero); return; }
    var drop = function () { if (hero.parentNode) hero.parentNode.removeChild(hero); };
    img.addEventListener('error', drop);
    /* A cached image may already have failed before the listener attached. */
    if (img.complete && !img.naturalWidth) drop();
  }

  function refreshOpen() {
    if (openTrackId == null || sheet.hidden) return;
    var t = TRACK.byId(openTrackId);
    if (t && t.state === 'done' && t.data) showSheet(record(t.data));
  }

  /* ---------- live scene readout ---------- */

  var sceneCur = null;

  /* A SPECIES BEATS A CATEGORY.

     The general classifier says "daisy" or, for a tree it has never met,
     "rapeseed". The species model says Bellis perennis. When it answers,
     that is what the readout shows - with the binomial under it, because a
     binomial is the thing you cannot get from looking. */
  var speciesCur = null;
  function sceneSpecies(r) {
    speciesCur = r;
    var chip = U.$('#sceneChip');
    if (!chip || !r) return;
    if (arCards()) { chip.hidden = true; return; }
    sceneCur = { name: r.name, score: r.score, kind: r.kindOf, alt: r.alt || [],
                 scientific: r.scientific, margin: r.margin, species: true };
    tele('#sceneName', r.name);
    tele('#sceneKind', r.scientific || r.kindOf || 'species');
    chip.hidden = false;
  }

  /* WHEN THE GENERAL CLASSIFIER IS ALLOWED TO SPEAK.

     "it thinks big outdoor trees are mouses and pots, and that toolboxes
      are speedboats, and 3d printers are sewing machines."

     Every one of those is the same thing: ImageNet has no class for a
     toolbox, a 3D printer or a mature oak, so asked about one it must
     return something else - and it will return the SAME something else
     every time, so repeating itself proves nothing here.

     The fix is not a higher threshold, it is knowing when this model is
     out of its depth. It is asked about the middle of an unbounded scene,
     where most of what a camera sees is not in its vocabulary at all. So
     it only gets to put a name on the screen when it is emphatic - and
     when it is not, the readout offers to ASK something that can answer,
     which is worth more than a wrong noun. */
  var SCENE_MEAN = 0.62, SCENE_MARGIN = 0.34;

  function sceneLabel(r) {
    var chip = U.$('#sceneChip');
    if (!chip) return;
    /* A live species answer outranks the general classifier's guess, and
       must not be overwritten by it a moment later. */
    if (speciesCur && (performance.now() - speciesCur.at) < 2500) return;
    speciesCur = null;
    /* The centre readout only earns its space when nothing has been boxed.
       With cards on the objects themselves it is a duplicate answer sitting
       over the scene. */
    if (!r || arCards()) {
      if (!chip.hidden) chip.hidden = true;
      sceneCur = null;
      return;
    }

    var strong = r.score >= SCENE_MEAN && (r.margin === undefined || r.margin >= SCENE_MARGIN);
    if (!strong) {
      /* Not a name. An offer. */
      sceneCur = { name: '', kind: r.kind, ask: true, box: r.box };
      tele('#sceneName', 'Tap to identify');
      tele('#sceneKind', 'not sure');
      if (chip.hidden) chip.hidden = false;
      return;
    }

    sceneCur = r;
    tele('#sceneName', r.name);
    tele('#sceneKind', r.kind || 'target');
    if (chip.hidden) chip.hidden = false;
  }
  function arCards() {
    var l = U.$('#arLayer');
    return !!(l && l.querySelector('.ar-card'));
  }

  /* Tapping the live label resolves its page - keyless, so this path works
     with nothing configured at all. */
  function openScene() {
    if (!sceneCur) return;
    /* The classifier had nothing worth saying, so send the middle of the
       frame to something that might. */
    if (sceneCur.ask) {
      var cv2 = U.$('#overlay');
      IDENT.atPoint(cv2.clientWidth / 2, cv2.clientHeight / 2);
      return;
    }
    /* A species answer already has its binomial; go straight to the taxon
       record rather than asking the general classifier's word about it. */
    if (sceneCur.species) {
      openPending(sceneCur.name);
      var want = sceneCur;
      WIKI.taxon(want.scientific || want.name).then(function (w) {
        openRecord({
          kind: want.kind, name: want.name, scientific: want.scientific,
          confidence: want.score, alt: want.alt || [], margin: want.margin,
          wiki: w, source: 'on-device species'
        });
      }).catch(function () {
        openRecord({ kind: want.kind, name: want.name, scientific: want.scientific,
                     confidence: want.score, alt: want.alt || [], wiki: null,
                     source: 'on-device species' });
      });
      return;
    }
    var name = sceneCur.name, score = sceneCur.score, alt = sceneCur.alt || [];
    openPending(name);
    WIKI.taxon(name).then(function (w) {
      return (w && w.extract) ? w : WIKI.thing(name);
    }).then(function (w) {
      showSheet(record({
        kind: (w && w.scientific) ? 'plant' : 'object',
        name: name, confidence: score, scientific: (w && w.scientific) || '',
        alt: alt, margin: sceneCur ? sceneCur.margin : undefined, wiki: w, source: 'on-device'
      }));
    });
  }

  /* ---------- captions ---------- */

  function captionDraw(lines, interim) {
    var bar = U.$('#captionBar');
    var src = U.$('#capSource'), main = U.$('#capMain'), meta = U.$('#capMeta');
    /* THE chokepoint. Several call sites reach here after an async gap - a
       translation resolving, a late recognition result - and this function
       ends by unhiding the bar. Without this one check any of them can
       reopen captions the user has switched off. */
    if (!CAPS.running()) {
      src.textContent = ''; main.textContent = ''; meta.textContent = '';
      bar.hidden = true;
      document.body.classList.remove('caps-on');
      return;
    }

    if (!lines.length && !interim) { src.textContent = ''; main.textContent = ''; meta.textContent = ''; return; }

    var last = lines[lines.length - 1];
    var showBoth = SET.get('capBoth');
    var out = last ? (last.out || last.src) : '';

    if (interim) {
      main.innerHTML = (out ? U.esc(out) + ' ' : '') + '<span class="interim">' + U.esc(interim) + '</span>';
    } else {
      main.textContent = out;
    }
    src.textContent = (showBoth && last && last.out && last.out !== last.src) ? last.src : '';
    meta.textContent = last && last.pending ? 'TRANSLATING' : (last && last.note ? last.note : '');
    bar.hidden = false;
  }

  function captionState(s) {
    var btn = U.$('#btnCaptions');
    btn.setAttribute('aria-pressed', s === 'listening' || s === 'paused' ? 'true' : 'false');
    if (s === 'off') U.$('#captionBar').hidden = true;
  }

  /* One line saying what the recogniser is actually doing. Captions "either
     work or fail, mostly fail" because every failure was silent - a dead
     engine and a quiet room looked identical. They do not now. */
  function captionNote(txt) {
    var meta = U.$('#capMeta');
    if (!meta) return;
    txt = String(txt || '');
    if (meta.textContent !== txt) meta.textContent = txt;
    if (txt) U.$('#captionBar').hidden = false;
  }

  /* ---------- settings ---------- */

  /* Say plainly which half is running. "Detector down, labelling fine" is a
     very different message from "nothing works", and the app treats them
     differently, so the screen must too. */
  function modelStatus() {
    var el = U.$('#modelStatus');
    if (!el || !window.SL_DIAG) return;
    var d = window.SL_DIAG();
    var okC = d.classifier === 'ok', okD = d.detector === 'ok';
    if (okC && okD) { el.className = 'status ok'; el.textContent = 'READY / ' + String(d.backend || '').toUpperCase(); }
    else if (okC) { el.className = 'status wait'; el.textContent = 'LIVE LABELLING OK / NO MULTI-OBJECT BOXES'; }
    else { el.className = 'status bad'; el.textContent = String(d.classifier).toUpperCase(); }
  }

  function buildSettings() {
    var vs = U.$('#optVoice');
    if (vs) vs.checked = !!SET.get('voice');
    var from = U.$('#optCapFrom'), to = U.$('#optCapTo');
    from.appendChild(U.el('option', { value: 'auto', text: 'Auto (device language)' }));
    CAPS.LANGS.forEach(function (l) { from.appendChild(U.el('option', { value: l[0], text: l[1] })); });
    CAPS.TARGETS.forEach(function (l) { to.appendChild(U.el('option', { value: l[0], text: l[1] })); });
    to.appendChild(U.el('option', { value: '', text: 'Do not translate' }));

    U.$('#apiBase').value = SET.get('apiBase');
    U.$('#optFaces').checked = !!SET.get('faces');
    U.$('#optConf').value = SET.get('conf');
    U.$('#confVal').textContent = Number(SET.get('conf')).toFixed(2);
    U.$('#optPace').value = String(SET.get('pace'));
    from.value = SET.get('capFrom');
    to.value = SET.get('capTo');
    U.$('#optCapBoth').checked = !!SET.get('capBoth');
    var b = window.KH_BUILD || { sha: '?', at: '?' };
    U.$('#buildLine').textContent = 'BUILD ' + b.sha + ' / ' + b.at;

    if (!CAPS.supported()) {
      U.$('#btnCaptions').style.opacity = '.4';
      U.$('#btnCaptions').title = 'This browser has no speech recognition';
    }
  }

  function wire() {
    U.$('#btnSettings').addEventListener('click', function () { settings.hidden = false; });
    U.$('#settingsClose').addEventListener('click', function () { settings.hidden = true; });
    U.$('#sheetClose').addEventListener('click', closeSheet);

    U.$('#apiBase').addEventListener('change', function () {
      SET.set('apiBase', this.value.trim());
      var s = U.$('#apiStatus');
      s.textContent = ''; s.className = 'status';
    });

    U.$('#btnTest').addEventListener('click', function () {
      var s = U.$('#apiStatus');
      if (!SET.hasApi()) { s.className = 'status bad'; s.textContent = 'ENTER A FULL https:// URL FIRST'; return; }
      s.className = 'status wait'; s.textContent = 'CHECKING…';
      U.fetchT(SET.api('/v1/health'), {}, 9000)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) throw new Error('bad');
          var f = j.features || {};
          var on = Object.keys(f).filter(function (k) { return f[k]; });
          s.className = 'status ok';
          s.textContent = 'CONNECTED / ' + (j.engine ? String(j.engine).toUpperCase() + ' / ' : '') +
                          (on.length ? on.join(' ').toUpperCase() : 'NOTHING ENABLED');
          tele('#tEng', j.engine ? String(j.engine).toUpperCase().slice(0, 10) : 'CLOUD');
        })
        .catch(function () {
          s.className = 'status bad';
          s.textContent = 'NO RESPONSE / CHECK THE URL';
        });
    });

    U.$('#btnReload').addEventListener('click', function () {
      var s = U.$('#modelStatus');
      s.className = 'status wait'; s.textContent = 'LOADING…';
      window.SL_RELOAD().then(function () { modelStatus(); });
    });

    U.$('#btnSettings').addEventListener('click', modelStatus);

    U.$('#btnReset').addEventListener('click', function () {
      var s = U.$('#modelStatus');
      s.className = 'status wait'; s.textContent = 'CLEARING…';
      window.SL_RESET();
    });

    U.$('#optFaces').addEventListener('change', function () { SET.set('faces', this.checked); });
    U.$('#optConf').addEventListener('input', function () {
      SET.set('conf', parseFloat(this.value));
      U.$('#confVal').textContent = Number(this.value).toFixed(2);
    });
    U.$('#optPace').addEventListener('change', function () { SET.set('pace', parseInt(this.value, 10)); });
    U.$('#optCapFrom').addEventListener('change', function () { SET.set('capFrom', this.value); CAPS.relang(); });
    U.$('#optCapTo').addEventListener('change', function () { SET.set('capTo', this.value); });
    U.$('#optCapBoth').addEventListener('change', function () { SET.set('capBoth', this.checked); });

    var keyEl = U.$('#apiKey');
    if (keyEl) {
      keyEl.value = SET.get('apiKey') || '';
      keyEl.addEventListener('change', function () { SET.set('apiKey', this.value.trim()); });
    }

    /* A nudge, not a switch: the decoder is always watching, and this puts
       its pace back to brisk and says so, for someone holding a label up
       after a quiet minute. Shown where the browser has no scanner of its
       own, which is where that pause is longest. */
    var sb = U.$('#btnScan');
    if (sb) {
      sb.addEventListener('click', function () {
        SCAN.burst();
        sb.setAttribute('aria-pressed', 'true');
        status('LOOKING FOR A CODE\u2026', 'busy');
        setTimeout(function () {
          sb.setAttribute('aria-pressed', 'false');
          if (!SCAN.bursting()) status('', '');
        }, 9000);
      });
    }

    var gk = U.$('#geminiKey');
    if (gk) {
      gk.value = SET.get('geminiKey') || '';
      gk.addEventListener('change', function () { SET.set('geminiKey', this.value.trim()); GEM._reset(); });
    }
    var gt = U.$('#btnGemTest');
    if (gt) gt.addEventListener('click', function () {
      setText('#gemStatus', 'Asking\u2026');
      GEM.test().then(function (r) {
        setText('#gemStatus', r.ok ? ('Working. ' + r.model + ' answered.') : ('No: ' + r.error));
      });
    });

    var vb = U.$('#optVoice');
    if (vb) {
      vb.checked = !!SET.get('voice');
      vb.addEventListener('change', function () {
        SET.set('voice', this.checked);
        if (this.checked) startVoice(); else VOICE.stop();
      });
    }
    var vbtn = U.$('#btnVoice');
    if (vbtn) vbtn.addEventListener('click', function () {
      if (!VOICE.state().on) { SET.set('voice', true); if (vb) vb.checked = true; startVoice(); }
      VOICE.wake();
    });

    var fm = U.$('#optFaceMem');
    if (fm) {
      fm.checked = FACES.isOn();
      fm.addEventListener('change', function () {
        FACES.setOn(this.checked);
        buildFaceList();
        if (this.checked) {
          toastFace('Downloading the face models. Everything stays on this device.');
          FACES.start().then(function () { buildFaceList(); });
        }
      });
    }
    var wipe = U.$('#btnFaceWipe');
    if (wipe) wipe.addEventListener('click', function () {
      if (!FACES.all().length) { toastFace('Nobody is remembered.'); return; }
      if (window.confirm('Forget every face this device has learned? This cannot be undone.')) {
        FACES.wipe(); buildFaceList(); toastFace('All forgotten.');
      }
    });
    buildFaceList();

    var agree = U.$('#btnAgree');
    if (agree) agree.addEventListener('click', function () {
      if (!SET.hasApi()) { setText('#agreeStatus', 'Set an endpoint first.'); return; }
      agree.disabled = true;
      setText('#agreeStatus', 'Sending the agreement…');
      IDENT.post('/v1/agree', {})
        .then(function (r) {
          agree.disabled = false;
          setText('#agreeStatus', r && r.ok
            ? 'Accepted. The sharper model is available to this endpoint now.'
            : 'Not accepted: ' + ((r && r.error) || 'unknown'));
        })
        .catch(function (e) {
          agree.disabled = false;
          setText('#agreeStatus', 'Could not reach the endpoint: ' + String(e && e.message || e).slice(0, 70));
        });
    });

    U.$$('.mbtn[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        U.$$('.mbtn[data-mode]').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        SET.set('mode', b.dataset.mode);
        tele('#tMode', b.textContent.trim());
        TRACK.reset();
        dirty();
      });
    });

    U.$('#sceneChip').addEventListener('click', function (ev) { ev.stopPropagation(); openScene(); });

    U.$('#btnCaptions').addEventListener('click', function () {
      if (CAPS.running()) { CAPS.stop(); document.body.classList.remove('caps-on'); }
      else if (CAPS.start('captions')) { document.body.classList.add('caps-on'); }
    });

    U.$('#btnFlip').addEventListener('click', function () {
      CAM.flip().then(function () { SET.set('facing', CAM.current()); TRACK.reset(); dirty(); });
    });

    U.$('#stage').addEventListener('click', function (ev) {
      if (!CAM.live()) return;
      if (ev.target.closest('#rail,#hudTL,#hudTR,#sheet,#settings,#gate,#captionBar,#sceneChip,#codeCard,#radarPod,#nearCard')) return;
      var r = cv.getBoundingClientRect();
      var x = ev.clientX - r.left, y = ev.clientY - r.top;
      /* A face is checked first: tapping someone's face means "who is
         this", not "what is this object". */
      var f = faceAt(x, y);
      if (f) { nameFace(f); return; }
      var t = TRACK.hit(x, y);
      if (t) openTrack(t); else IDENT.atPoint(x, y);
    });
  }

  /* ---------- the voice assistant ---------- */

  /* What it has asked to be shown. A word or two naming a thing, and
     optionally a colour - never anything that could change how the app
     works, only what is drawn. */
  var voiceFocus = null;     // { what, colour, only, at }
  var VOICE_MS = 25000;      // how long its instruction stands

  function startVoice() {
    if (!VOICE.start()) {
      toastFace('This browser cannot listen. Chrome and Edge can; Safari often cannot.');
      return false;
    }
    voiceNote();
    return true;
  }

  function voiceNote() {
    var st = VOICE.state();
    var el = U.$('#voiceState');
    var btn = U.$('#btnVoice');
    if (btn) btn.setAttribute('aria-pressed', st.awake || st.thinking ? 'true' : 'false');
    if (!el) return;
    el.textContent = !st.on ? 'Off.'
      : st.thinking ? 'Thinking\u2026'
      : st.awake ? 'Listening for your question\u2026'
      : 'Waiting for "hey vision". Engine: ' + st.engine + '.';
  }

  function voiceEvent(ev) {
    if (ev.kind === 'awake') { status('LISTENING \u2014 ASK YOUR QUESTION', 'busy'); }
    else if (ev.kind === 'thinking') { status('\u201c' + ev.question + '\u201d', 'busy'); }
    else if (ev.kind === 'answer') {
      status(ev.answer.say || '', ev.answer.error ? 'bad' : '');
      setTimeout(function () { status('', ''); }, 7000);
    } else if (ev.kind === 'box' || ev.kind === 'only') {
      voiceFocus = { what: ev.what, colour: ev.colour || '', only: ev.kind === 'only',
                     at: performance.now() };
      dirty();
    } else if (ev.kind === 'clear') {
      voiceFocus = null;
      dirty();
    }
    voiceNote();
  }

  /* Does this target match what the voice was asked to point at? Loose on
     purpose - somebody says "the bike", the detector says "bicycle". */
  /* THE WORDS PEOPLE SAY, AGAINST THE WORDS THE DETECTOR KNOWS.

     Nobody says "bicycle" out loud, or "cell phone", or "potted plant".
     This is the small gap between how a person names a thing and how the
     model does - not a thesaurus, just the everyday words for the eighty
     classes the detector actually has. */
  var SAID_AS = {
    bike: 'bicycle', bicycle: 'bicycle', cycle: 'bicycle',
    phone: 'cell phone', mobile: 'cell phone',
    telly: 'tv', television: 'tv', screen: 'tv', monitor: 'tv',
    sofa: 'couch', settee: 'couch',
    bin: 'trash can', rubbish: 'trash can', trash: 'trash can',
    plant: 'potted plant', pot: 'potted plant',
    laptop: 'laptop', computer: 'laptop',
    table: 'dining table', desk: 'dining table',
    bag: 'backpack', rucksack: 'backpack', handbag: 'handbag',
    car: 'car', van: 'truck', lorry: 'truck',
    mug: 'cup', glass: 'wine glass',
    ball: 'sports ball', person: 'person', people: 'person',
    dog: 'dog', cat: 'cat', bird: 'bird'
  };

  function voiceMatches(t) {
    if (!voiceFocus || !voiceFocus.what) return false;
    var want = voiceFocus.what.toLowerCase()
      .replace(/^(the|a|an|that|those|these|my|your)\s+/, '').trim();
    if (!want) return false;
    var hay = ((t.label || '') + ' ' + (t.cls || '') + ' ' +
               ((t.species && t.species.scientific) || '')).toLowerCase();

    var tries = [want];
    var stem = want.replace(/(ies|es|s)$/, '');
    if (stem.length > 2 && stem !== want) tries.push(stem);
    [want, stem].forEach(function (w) {
      if (SAID_AS[w] && tries.indexOf(SAID_AS[w]) === -1) tries.push(SAID_AS[w]);
    });
    /* The last word of a phrase is usually the noun: "the red bike". */
    var lastWord = want.split(/\s+/).pop();
    if (lastWord && lastWord !== want) {
      tries.push(lastWord);
      if (SAID_AS[lastWord]) tries.push(SAID_AS[lastWord]);
    }

    for (var i = 0; i < tries.length; i++) {
      if (tries[i] && tries[i].length > 1 && hay.indexOf(tries[i]) !== -1) return true;
    }
    return false;
  }

  var VOICE_COLOURS = { green: '#6ee7a0', blue: '#8ab4ff', amber: '#ffc46b',
                        pink: '#ff9ad4', red: '#ff8080' };

  function voiceLive() {
    return !!(voiceFocus && (performance.now() - voiceFocus.at) < VOICE_MS);
  }

  /* ---------- faces this device has been told about ---------- */

  var faceSeen = [];
  function faces(list) { faceSeen = list || []; dirty(); }

  /* Drawn straight onto the overlay: a name belongs ON the person, and a
     face moves too quickly for a card that has to be laid out. */
  function drawFaces(ctx, w, h) {
    if (!faceSeen.length) return;
    ctx.save();
    faceSeen.forEach(function (f) {
      var s = CAM.toScreen(f.box);
      var x = s[0], y = s[1], bw = s[2], bh = s[3];
      if (bw < 18) return;

      var known = !!f.name;
      var col = known ? '#8ab4ff' : 'rgba(230,236,241,.55)';
      ctx.strokeStyle = col;
      ctx.lineWidth = known ? 2 : 1;
      if (!known) ctx.setLineDash([4, 5]);
      roundRect(ctx, x, y, bw, bh, Math.min(14, bw * 0.14));
      ctx.stroke();
      ctx.setLineDash([]);

      var label = known ? f.name : 'Tap to name';
      ctx.font = known ? '600 14px -apple-system,system-ui,sans-serif'
                       : '500 11px -apple-system,system-ui,sans-serif';
      var tw = ctx.measureText(label).width;
      var px = x + bw / 2 - tw / 2 - 10, py = y - 34;
      if (py < 4) py = y + bh + 8;
      ctx.fillStyle = known ? 'rgba(10,20,38,.86)' : 'rgba(6,9,12,.7)';
      roundRect(ctx, px, py, tw + 20, 26, 13);
      ctx.fill();
      ctx.strokeStyle = known ? 'rgba(138,180,255,.5)' : 'rgba(230,236,241,.2)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = known ? '#e6ecf1' : 'rgba(230,236,241,.72)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px + 10, py + 13);
      /* A borderline match is said less firmly than a certain one. */
      if (known && !f.sure) {
        ctx.fillStyle = 'rgba(230,236,241,.45)';
        ctx.font = '500 9.5px -apple-system,system-ui,sans-serif';
        ctx.fillText('possibly', px + 10, py + 34);
      }
    });
    ctx.restore();
  }

  /* A tap on a face names it, or corrects a name that is wrong. */
  function faceAt(x, y) {
    for (var i = 0; i < faceSeen.length; i++) {
      var s = CAM.toScreen(faceSeen[i].box);
      if (x >= s[0] - 10 && x <= s[0] + s[2] + 10 && y >= s[1] - 36 && y <= s[1] + s[3] + 10) {
        return faceSeen[i];
      }
    }
    return null;
  }

  function nameFace(f) {
    var was = f.name || '';
    var asked = window.prompt(was ? ('Name for this face (now "' + was + '")') : 'Who is this?', was);
    if (asked === null) return;
    var name = String(asked).trim();
    if (!name) { if (f.id) FACES.forget(f.id); toastFace('Forgotten.'); return; }
    var p = FACES.remember(f.descriptor, name);
    toastFace(p ? ('Saved as ' + p.name + '. Only on this device.') : 'Could not save that face.');
    buildFaceList();
  }
  function toastFace(m) { if (window.U && U.toast) U.toast(m, 3200); }

  /* The address book in settings: names, when you met them, and a way to
     forget. No pictures, because none are kept. */
  function buildFaceList() {
    var box = U.$('#faceList');
    if (!box) return;
    box.textContent = '';
    FACES.all().forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'face-row';
      var b = document.createElement('b'); b.textContent = p.name;
      var i = document.createElement('i');
      i.textContent = 'met ' + new Date(p.met).toLocaleDateString();
      var ren = document.createElement('button'); ren.textContent = 'RENAME';
      ren.addEventListener('click', function () {
        var n = window.prompt('Name', p.name);
        if (n !== null && String(n).trim()) { FACES.rename(p.id, n); buildFaceList(); }
      });
      var del = document.createElement('button'); del.textContent = 'FORGET';
      del.addEventListener('click', function () { FACES.forget(p.id); buildFaceList(); });
      row.appendChild(b); row.appendChild(i); row.appendChild(ren); row.appendChild(del);
      box.appendChild(row);
    });
    var st = U.$('#faceState');
    var s2 = FACES.state();
    if (st) {
      st.textContent = !s2.on ? 'Off'
        : s2.ready ? (s2.known + (s2.known === 1 ? ' person remembered' : ' people remembered'))
        : s2.error ? ('Could not start: ' + s2.error)
        : 'Loading the models\u2026';
    }
  }

  /* ---------- a scanned code ---------- */

  var codeRec = null;
  function hideCode() {
    var card = U.$('#codeCard');
    if (card) card.hidden = true;
    document.body.classList.remove('code-open');
    codeRec = null;
  }

  function showCode(hit) {
    var got = CODES.resolve(hit);
    if (!got) return;
    codeRec = got.record;
    paintCode(got.record, hit);
    got.done.then(function () { if (codeRec === got.record) paintCode(got.record, hit); });
  }

  function paintCode(rec, hit) {
    var card = U.$('#codeCard');
    if (!card) return;
    card.hidden = false;
    document.body.classList.add('code-open');

    var img = U.$('#codeImg');
    if (rec.image) { img.src = rec.image; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }

    var kicker = rec.kind === 'product' ? ((hit.format || 'barcode').toUpperCase())
               : rec.kind === 'link' ? ('QR \u00b7 ' + (rec.secure ? 'HTTPS' : 'NOT SECURE'))
               : (hit.format || 'CODE').toUpperCase();
    set('#codeKicker', kicker);
    set('#codeName', rec.pending ? 'Looking it up\u2026' : (rec.title || rec.name || rec.text || ''));
    set('#codeSub', rec.kind === 'product'
        ? [rec.brand, rec.quantity].filter(Boolean).join(' \u00b7 ')
        : rec.kind === 'link' ? (rec.finalUrl || rec.url) : '');

    var sc = U.$('#codeScore');
    if (rec.health) {
      sc.hidden = false;
      sc.className = 'code-score ' + (rec.health.score >= 70 ? 'good' : rec.health.score >= 45 ? 'ok' : 'bad');
      sc.querySelector('b').textContent = String(rec.health.score);
    } else { sc.hidden = true; }

    var body = U.$('#codeBody');
    body.innerHTML = codeBody(rec);

    var go = U.$('#codeGo');
    if (rec.kind === 'link') {
      go.hidden = false;
      go.href = rec.url;
      go.textContent = 'OPEN ' + (rec.host || '').toUpperCase();
    } else if (rec.kind === 'product' && rec.code) {
      go.hidden = false;
      go.href = 'https://world.openfoodfacts.org/product/' + encodeURIComponent(rec.code);
      go.textContent = 'SEE THE FULL RECORD';
    } else { go.hidden = true; }
  }

  function codeBody(rec) {
    var h = '';
    if (rec.pending) return '<p>Looking it up\u2026</p>';

    if (rec.kind === 'link') {
      if (rec.risks && rec.risks.length) {
        h += rec.risks.map(function (r) { return '<b class="code-warn">' + U.esc(r) + '</b>'; }).join('');
      }
      if (rec.description) h += '<p>' + U.esc(rec.description) + '</p>';
      if (rec.note) h += '<p>' + U.esc(rec.note) + '</p>';
      h += '<h4>Full address</h4><p class="mono">' + U.esc(rec.finalUrl || rec.url) + '</p>';
      return h;
    }

    if (rec.kind === 'text') return '<p class="mono">' + U.esc(rec.text) + '</p>';

    if (rec.missing || rec.note) h += '<p>' + U.esc(rec.note) + '</p>';

    /* The score is shown WITH its working, because a number out of 100 that
       nobody can argue with is not a fact, it is a verdict. */
    if (rec.health) {
      h += '<h4>How that score is made</h4>';
      h += rec.health.parts.map(function (p) {
        return '<div class="code-row"><i>' + U.esc(p.k + (p.v ? '  ' + p.v : '')) + '</i><span>' +
               (p.d ? (p.d > 0 ? '+' : '') + p.d : U.esc(String(rec.health.base))) + '</span></div>';
      }).join('');
      h += '<p>Nutri-Score mapped onto 0-100, then processing and additives. Open Food Facts data.</p>';
    }

    if (rec.levels && rec.levels.length) {
      h += '<h4>Per 100 g</h4>' + rec.levels.map(function (l) {
        return '<div class="code-row"><i>' + U.esc(l.k) + '</i><span>' + U.esc(l.v) + '</span></div>';
      }).join('');
    }

    if (rec.additives && rec.additives.length) {
      h += '<h4>' + rec.additives.length + (rec.additives.length === 1 ? ' additive' : ' additives') + '</h4>';
      h += rec.additives.map(function (a) {
        return '<div class="code-e"><b>' + U.esc(a.code) + '</b><span>' +
               U.esc(a.what || 'not described in the database') + '</span></div>';
      }).join('');
    } else if (!rec.missing) {
      h += '<h4>Additives</h4><p>None recorded.</p>';
    }

    if (rec.allergens && rec.allergens.length) {
      h += '<h4>Allergens</h4><p>' + U.esc(rec.allergens.join(', ')) + '</p>';
    }
    if (rec.ingredients) {
      h += '<h4>Ingredients</h4><p>' + U.esc(rec.ingredients.slice(0, 600)) + '</p>';
    }
    return h;
  }

  /* ---------- the weather card, the battery, things nearby ---------- */

  /* Guarded writes only. These update on a position fix and on the minute,
     not every frame, but the guard is the habit that stops a repaint
     costing anything when nothing changed. */
  function ambient(st) {
    var w = st.weather, card = U.$('#wxCard');
    if (card) {
      if (w) {
        set('#wxTemp', w.temp + '\u00b0C');
        set('#wxSky', st.sky);
        set('#wxWind', 'Wind ' + w.wind + ' km/h' +
            (typeof st.heading === 'number' ? ' \u00b7 facing ' + compass(st.heading) : ''));
        var ic = U.$('#wxIcon');
        if (ic && ic.dataset.code !== String(w.code)) {
          ic.dataset.code = String(w.code);
          ic.innerHTML = wxSvg(w.code);
        }
      }
      card.hidden = !w;
    }
    nearby(st);

    /* The pod says where you are when you are still and how fast when you
       are not - a speed of 0.0 sitting on a table is noise. */
    var t = st.trip;
    set('#podSpeed', (t && t.speed >= 0.55) ? GEO.speedText() : '');
  }

  /* Things nearby, from the same geosearch the map draws. Rebuilt only when
     the list actually changes - it is on screen over a live camera. */
  var nearKey = '';
  function nearby(st) {
    var box = U.$('#nearRows'), card = U.$('#nearCard');
    if (!box || !card) return;
    var list = (st.places || []).slice(0, 4);
    var key = list.map(function (p) { return p.title + p.dist; }).join('|');
    card.hidden = !list.length;
    if (key === nearKey) return;
    nearKey = key;
    box.textContent = '';
    list.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'near-row';
      var n = document.createElement('span'); n.textContent = p.title;
      var d = document.createElement('i');
      d.textContent = p.dist < 1000 ? (p.dist + ' m') : ((p.dist / 1000).toFixed(1) + ' km');
      row.appendChild(n); row.appendChild(d);
      box.appendChild(row);
    });
  }

  function set(sel, v) { var el = U.$(sel); if (el && el.textContent !== v) el.textContent = v; }
  function setText(sel, v) { set(sel, v); }
  var ROSE = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function compass(deg) { return ROSE[Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }

  /* One drawing per weather family. currentColor, so the tint is CSS's. */
  function wxSvg(code) {
    var o = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">';
    if (code === 0 || code === 1)
      return o + '<circle cx="12" cy="12" r="4.4"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></svg>';
    if (code === 2 || code === 3 || code === 45 || code === 48)
      return o + '<path d="M7 18h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1A3.6 3.6 0 0 0 7 18z"/></svg>';
    if (code >= 71 && code <= 77 || code === 85 || code === 86)
      return o + '<path d="M7 15h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1A3.6 3.6 0 0 0 7 15z"/><path d="M9 19h.01M12 20.5h.01M15 19h.01"/></svg>';
    if (code >= 95)
      return o + '<path d="M7 15h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1A3.6 3.6 0 0 0 7 15z"/><path d="M13 17l-2.5 4h4L12 24"/></svg>';
    return o + '<path d="M7 15h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1A3.6 3.6 0 0 0 7 15z"/><path d="M9 18.5l-1 2.5M12.5 18.5l-1 2.5M16 18.5l-1 2.5"/></svg>';
  }

  /* The battery is on the chip when the browser will say. */
  function startBattery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(function (b) {
      function show() {
        var el = U.$('#tBatt');
        if (!el) return;
        el.hidden = false;
        set('#tBatt', Math.round(b.level * 100) + '%');
      }
      show();
      b.addEventListener('levelchange', show);
    }).catch(function () {});
  }

  /* A place from the map opens in the same dossier everything else uses. */
  function openPlace(p) {
    MAP.setOpen(false);
    openRecord({
      title: p.title,
      kicker: 'PLACE \u00b7 ' + Math.round(p.bearing) + '\u00b0 \u00b7 ' +
              (p.dist < 1000 ? p.dist + ' m' : (p.dist / 1000).toFixed(1) + ' km'),
      wiki: p.title,
      specs: [{ k: 'Bearing', v: Math.round(p.bearing) + '\u00b0 from north' },
              { k: 'Distance', v: p.dist + ' m' },
              { k: 'Coordinates', v: p.lat.toFixed(4) + ', ' + p.lon.toFixed(4) }]
    });
  }

  return { _navShapes: function () { return navShapes.slice(); }, init: init, draw: draw, openPlace: openPlace, dirty: dirty, resize: resize, tele: tele, modelStatus: modelStatus,
           status: status,
           openTrack: openTrack, openRecord: openRecord, openPending: openPending,
           openError: openError, needEndpoint: needEndpoint, close: closeSheet,
           refreshOpen: refreshOpen, sceneLabel: sceneLabel, sceneSpecies: sceneSpecies,
           faces: faces, faceAt: faceAt, nameFace: nameFace, buildFaceList: buildFaceList,
           voiceFocus: function () { return voiceLive() ? voiceFocus : null; },
           voiceMatches: voiceMatches, startVoice: startVoice,
           openScene: openScene,
           captionDraw: captionDraw, captionState: captionState, captionNote: captionNote,
           get needsDraw() { return needsDraw; } };
})();
