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
      var named = !!t.label;

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

      /* Bracketed target. Corner ticks only - a full box hides the subject,
         which is the thing the user is actually trying to look at. */
      var c = Math.min(18, bw * 0.26, bh * 0.26);
      var dismissed = t.scan === 'dismissed' && !named;
      var scanning = (t.scan === 'scanning' || t.state === 'queued') && !named;

      ctx.save();
      ctx.strokeStyle = dismissed ? 'rgba(230,236,241,.5)' : col;
      ctx.lineWidth = named ? 1.6 : 1.1;
      ctx.globalAlpha = named ? 0.95 : dismissed ? 0.3 : scanning ? 0.75 : 0.5;
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

    AR.sweep();
    needsDraw = false;
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

  function statusFromEngine() {
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
               (rec.source === 'on-device' ? ' / ON-DEVICE' : rec.source === 'workers-ai' ? ' / WORKERS AI' : '') +
               '</div>';
    html += '<h3 class="d-title">' + U.esc(rec.name) + '</h3>';
    if (rec.scientific) html += '<p class="d-sci">' + U.esc(rec.scientific) + '</p>';
    /* No confidence bar. A number beside an answer that might be wrong does
       not make it less wrong, and the owner asked for them gone. */
    if (w.thumb) html += '<div class="d-hero" data-hero><img src="' + U.esc(w.thumb) + '" alt="" loading="lazy"></div>';

    /* Model-supplied specs come first for objects - that is the whole point
       of pointing a camera at a 3D printer or a robot. */
    if (rec.specs && rec.specs.length) {
      html += grid(rec.specs.map(function (s) { return [s.k, s.v]; }));
    }

    if (rec.kind === 'person') {
      html += grid([
        ['Known for', (w.occupations || []).slice(0, 3).join(', ')],
        ['Born', w.bornYear ? String(w.bornYear) : '']
      ]);
    } else if (rec.kind === 'plant' || rec.kind === 'animal' || rec.kind === 'insect') {
      html += grid([['Rank', w.rank], ['Status', w.conservation]]);
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
      html += '<p class="d-note">Also possible: ' + U.esc(rec.alt.slice(0, 3).join(' / ')) + '</p>';
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

  function sceneLabel(r) {
    var chip = U.$('#sceneChip');
    if (!chip) return;
    /* The centre readout only earns its space when nothing has been boxed.
       With cards on the objects themselves it is a duplicate answer sitting
       over the scene. */
    if (!r || arCards()) {
      if (!chip.hidden) chip.hidden = true;
      sceneCur = null;
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
    var name = sceneCur.name, score = sceneCur.score, alt = sceneCur.alt || [];
    openPending(name);
    WIKI.taxon(name).then(function (w) {
      return (w && w.extract) ? w : WIKI.thing(name);
    }).then(function (w) {
      showSheet(record({
        kind: (w && w.scientific) ? 'plant' : 'object',
        name: name, confidence: score, scientific: (w && w.scientific) || '',
        alt: alt, wiki: w, source: 'on-device'
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
      else if (CAPS.start()) { document.body.classList.add('caps-on'); }
    });

    U.$('#btnFlip').addEventListener('click', function () {
      CAM.flip().then(function () { SET.set('facing', CAM.current()); TRACK.reset(); dirty(); });
    });

    U.$('#stage').addEventListener('click', function (ev) {
      if (!CAM.live()) return;
      if (ev.target.closest('#rail,#hudTL,#hudTR,#sheet,#settings,#gate,#captionBar,#sceneChip')) return;
      var r = cv.getBoundingClientRect();
      var x = ev.clientX - r.left, y = ev.clientY - r.top;
      var t = TRACK.hit(x, y);
      if (t) openTrack(t); else IDENT.atPoint(x, y);
    });
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

  return { init: init, draw: draw, openPlace: openPlace, dirty: dirty, resize: resize, tele: tele, modelStatus: modelStatus,
           status: status,
           openTrack: openTrack, openRecord: openRecord, openPending: openPending,
           openError: openError, needEndpoint: needEndpoint, close: closeSheet,
           refreshOpen: refreshOpen, sceneLabel: sceneLabel, openScene: openScene,
           captionDraw: captionDraw, captionState: captionState, captionNote: captionNote,
           get needsDraw() { return needsDraw; } };
})();
