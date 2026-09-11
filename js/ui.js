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

  function draw(tracks) {
    if (!ctx) return;
    var w = cv.clientWidth, h = cv.clientHeight;
    ctx.clearRect(0, 0, w, h);

    tracks.forEach(function (t) {
      var s = CAM.toScreen(t.box);
      var kind = IDENT.kindOf(t.cls);
      var col = COLOR[kind] || COLOR.object;
      var named = !!t.label;

      var x = s[0], y = s[1], bw = s[2], bh = s[3];
      if (bw < 24 || bh < 24) return;              // too small to annotate legibly

      /* Skip anything barely in frame: a plate with its leader line running
         off the edge reads as a glitch, not as instrumentation. */
      var vx = Math.max(0, Math.min(x + bw, w) - Math.max(x, 0));
      var vy = Math.max(0, Math.min(y + bh, h) - Math.max(y, 0));
      if (vx * vy < bw * bh * 0.35) return;

      /* Bracketed target. Corner ticks only - a full box hides the subject,
         which is the thing the user is actually trying to look at. */
      var c = Math.min(18, bw * 0.26, bh * 0.26);
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = named ? 1.6 : 1.1;
      ctx.globalAlpha = named ? 0.95 : 0.5;
      [[x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1]]
        .forEach(function (p) {
          ctx.beginPath();
          ctx.moveTo(p[0] + c * p[2], p[1]);
          ctx.lineTo(p[0], p[1]);
          ctx.lineTo(p[0], p[1] + c * p[3]);
          ctx.stroke();
        });
      ctx.restore();

      var text = named ? t.label
               : t.state === 'queued' ? 'SCANNING'
               : String(t.cls).toUpperCase();
      if (t.state === 'skipped' && kind === 'person' && !named) text = 'PERSON';
      text = text.toUpperCase();

      /* Leader line out of the top-right corner to a plate. This is what
         makes it read as instrumentation rather than a floating chip. */
      ctx.save();
      ctx.font = '500 11px ui-monospace,SFMono-Regular,Menlo,monospace';
      var tw = ctx.measureText(text).width;
      var padX = 8, plateH = 22;
      var leader = 14;

      var px = x + bw + leader;
      var py = y - plateH - 6;
      var flip = px + tw + padX * 2 > w - 6;       // not enough room on the right
      if (flip) px = x - leader - (tw + padX * 2);
      if (px < 6) { px = U.clamp(x, 6, w - tw - padX * 2 - 6); }
      if (py < 6) py = y + 6;

      ctx.strokeStyle = col;
      ctx.globalAlpha = named ? 0.8 : 0.4;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(flip ? x : x + bw, y);
      ctx.lineTo(flip ? px + tw + padX * 2 : px, py + plateH / 2);
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(5,6,7,.82)';
      ctx.fillRect(px, py, tw + padX * 2, plateH);
      ctx.fillStyle = col;
      ctx.fillRect(px, py, 2, plateH);             // accent spine
      ctx.strokeStyle = 'rgba(230,236,241,.18)';
      ctx.strokeRect(px + 0.5, py + 0.5, tw + padX * 2 - 1, plateH - 1);

      ctx.fillStyle = named ? '#e6ecf1' : 'rgba(230,236,241,.66)';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, px + padX, py + plateH / 2 + 0.5);
      ctx.restore();
    });

    needsDraw = false;
  }

  /* ---------- dossier ---------- */

  function showSheet(html) { sheetBody.innerHTML = html; sheet.hidden = false; }
  function closeSheet() { sheet.hidden = true; openTrackId = null; }

  function confBar(c) {
    var pct = Math.round(U.clamp(c, 0, 1) * 100);
    return '<div class="d-conf"><span>CONFIDENCE</span><span class="bar"><i style="width:' + pct + '%"></i></span><span>' + pct + '%</span></div>';
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
    showSheet('<div class="d-kicker">NO RESULT</div><h3 class="d-title">Not identified</h3>' +
      '<p class="d-body">' + U.esc(human) + '</p>' +
      '<div class="d-actions"><button class="obtn" onclick="UI.close()">CLOSE</button></div>');
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
    html += confBar(rec.confidence);
    if (w.thumb) html += '<div class="d-hero"><img src="' + U.esc(w.thumb) + '" alt="" loading="lazy"></div>';

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

  function refreshOpen() {
    if (openTrackId == null || sheet.hidden) return;
    var t = TRACK.byId(openTrackId);
    if (t && t.state === 'done' && t.data) showSheet(record(t.data));
  }

  /* ---------- live scene readout ---------- */

  var sceneCur = null;

  function sceneLabel(r) {
    var chip = U.$('#sceneChip'), ret = U.$('#reticle');
    ret.hidden = false;

    if (!r) {
      if (!chip.hidden) chip.hidden = true;
      ret.classList.remove('hot');
      sceneCur = null;
      return;
    }
    sceneCur = r;
    ret.classList.add('hot');

    var pct = Math.round(r.score * 100);
    tele('#sceneName', r.name);
    tele('#scenePct', pct + '%');
    tele('#sceneKind', (r.kind || 'TARGET').toUpperCase());
    var bar = U.$('#sceneBar');
    var wpc = pct + '%';
    if (bar && bar.style.width !== wpc) bar.style.width = wpc;
    if (chip.hidden) chip.hidden = false;
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
    if (!lines.length && !interim) { src.textContent = ''; main.textContent = ''; return; }

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
    var meta = U.$('#capMeta');
    if (s === 'denied') meta.textContent = 'MICROPHONE BLOCKED';
    else if (s === 'error') meta.textContent = 'CAPTION ERROR';
    if (s === 'off') U.$('#captionBar').hidden = true;
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
    U.$('#buildLine').textContent = 'ON-DEVICE TIER: UNLIMITED, NO KEY, WORKS OFFLINE';

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
      if (CAPS.running()) { CAPS.stop(); CAPS.clear(); document.body.classList.remove('caps-on'); }
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

  return { init: init, draw: draw, dirty: dirty, resize: resize, tele: tele, modelStatus: modelStatus,
           openTrack: openTrack, openRecord: openRecord, openPending: openPending,
           openError: openError, needEndpoint: needEndpoint, close: closeSheet,
           refreshOpen: refreshOpen, sceneLabel: sceneLabel, openScene: openScene,
           captionDraw: captionDraw, captionState: captionState,
           get needsDraw() { return needsDraw; } };
})();
