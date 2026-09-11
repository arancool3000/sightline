/* Sightline - everything that draws. */
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

  /* ---------- overlay ---------- */

  /* One hue per category. Every label also carries the category word in
     the sheet, so colour is never the only thing distinguishing them. */
  var COLOR = {
    person: '#8ab4ff', animal: '#f5a3d0', plant: '#5ddc8c',
    insect: '#ffcf5d', vehicle: '#ff9f6b', object: '#d7d7de'
  };

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function draw(tracks) {
    if (!ctx) return;
    var w = cv.clientWidth, h = cv.clientHeight;
    ctx.clearRect(0, 0, w, h);

    tracks.forEach(function (t) {
      var s = CAM.toScreen(t.box);
      var kind = IDENT.kindOf(t.cls);
      var col = COLOR[kind] || COLOR.object;
      var known = t.state === 'done' && t.label;

      /* Corner brackets rather than a full box - lighter, and it does not
         hide the subject. A solid outline only once we know what it is. */
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = known ? 2.5 : 1.8;
      ctx.globalAlpha = known ? 1 : 0.62;

      if (known) {
        roundRect(s[0], s[1], s[2], s[3], 12);
        ctx.stroke();
      } else {
        var c = Math.min(20, s[2] * 0.3, s[3] * 0.3);
        [[s[0], s[1], 1, 1], [s[0] + s[2], s[1], -1, 1],
         [s[0], s[1] + s[3], 1, -1], [s[0] + s[2], s[1] + s[3], -1, -1]].forEach(function (p) {
          ctx.beginPath();
          ctx.moveTo(p[0] + c * p[2], p[1]);
          ctx.lineTo(p[0], p[1]);
          ctx.lineTo(p[0], p[1] + c * p[3]);
          ctx.stroke();
        });
      }
      ctx.restore();

      /* Label chip */
      var text = known ? t.label
               : t.state === 'queued' ? '…'
               : U.titleCase(t.cls);
      if (t.state === 'skipped' && kind === 'person') text = 'Person';

      ctx.save();
      ctx.font = '600 13px -apple-system,system-ui,sans-serif';
      var pad = 8;
      var tw = ctx.measureText(text).width;
      var chipW = tw + pad * 2, chipH = 24;
      var cx = U.clamp(s[0], 4, w - chipW - 4);
      var cy = s[1] - chipH - 6;
      if (cy < 4) cy = U.clamp(s[1] + 6, 4, h - chipH - 4);

      ctx.fillStyle = known ? col : 'rgba(0,0,0,.66)';
      roundRect(cx, cy, chipW, chipH, 7);
      ctx.fill();
      if (!known) { ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 1; ctx.stroke(); }

      ctx.fillStyle = known ? '#08130c' : '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cx + pad, cy + chipH / 2 + 0.5);
      ctx.restore();
    });

    needsDraw = false;
  }

  /* ---------- detail sheet ---------- */

  function showSheet(html) {
    sheetBody.innerHTML = html;
    sheet.hidden = false;
  }
  function closeSheet() { sheet.hidden = true; openTrackId = null; }

  function confBar(c) {
    var pct = Math.round(U.clamp(c, 0, 1) * 100);
    return '<div class="sh-conf"><span>Confidence</span><span class="bar"><i style="width:' + pct + '%"></i></span><span>' + pct + '%</span></div>';
  }

  function facts(pairs) {
    var live = pairs.filter(function (p) { return p[1]; });
    if (!live.length) return '';
    return '<dl class="sh-facts">' + live.map(function (p) {
      return '<div class="fact"><dt>' + U.esc(p[0]) + '</dt><dd>' + U.esc(p[1]) + '</dd></div>';
    }).join('') + '</dl>';
  }

  function linkBtn(href, label, solid) {
    if (!href) return '';
    return '<a class="ghost' + (solid ? ' solid' : '') + '" target="_blank" rel="noopener noreferrer" href="' +
      U.esc(href) + '">' + U.esc(label) +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M8 7h9v9"/></svg></a>';
  }

  function openPending(msg) {
    showSheet('<div class="sh-kicker">Identifying</div>' +
      '<h3 class="sh-title">' + U.esc(msg) + '</h3>' +
      '<div class="skel" style="width:88%"></div><div class="skel" style="width:72%"></div><div class="skel" style="width:80%"></div>');
  }

  function openError(why) {
    var human = /no-endpoint/.test(why) ? 'No analysis endpoint is set. Open Settings and paste your Worker URL.'
              : /quota|429/.test(why) ? 'The free daily allowance is used up. It resets at midnight UTC.'
              : /Failed to fetch|NetworkError/i.test(why) ? 'Could not reach the analysis endpoint. Check the URL and your connection.'
              : 'That could not be identified. Try getting closer, or steadier light.';
    showSheet('<div class="sh-kicker">No result</div><h3 class="sh-title">Nothing identified</h3>' +
      '<p class="sh-body">' + U.esc(human) + '</p>' +
      '<div class="sh-actions"><button class="ghost" onclick="UI.close()">Close</button></div>');
  }

  function needEndpoint() {
    openError('no-endpoint');
  }

  /* The honest explanation when the person gate refused a name.
     This is the Mozart case: we say what happened rather than guessing. */
  function gatedPerson(rec) {
    var why;
    if (rec.gated === 'deceased') {
      var who = rec.deceasedName ? U.esc(rec.deceasedName) : 'a historical figure';
      var yr = rec.diedYear ? ' (died ' + U.esc(String(rec.diedYear)) + ')' : '';
      why = 'The closest match online was <b>' + who + '</b>' + yr +
            ', who is no longer alive &mdash; so this is a resemblance, not that person. ' +
            'Sightline only ever labels living people, which is what stops a lookalike being named.';
    } else if (rec.gated === 'no-article' || rec.gated === 'not-a-person') {
      why = 'No strong match to a public figure with a Wikipedia page, so no name is shown.';
    } else if (rec.gated === 'faces-off') {
      why = 'Naming people is switched off in Settings.';
    } else {
      why = 'The match was not confident enough to put a name on screen.';
    }
    return '<div class="sh-kicker">Person</div><h3 class="sh-title">Not identified</h3>' +
      '<p class="sh-body">' + why + '</p>' +
      '<p class="sh-note">Sightline never attempts to identify private individuals. It only matches against notable people who already have a public encyclopedia entry.</p>';
  }

  function record(rec) {
    if (!rec) return '<p class="sh-body">Nothing came back.</p>';

    if (rec.kind === 'person' && (!rec.name || rec.gated)) return gatedPerson(rec);
    if (!rec.name) {
      return '<div class="sh-kicker">' + U.esc(IDENT.KICKER[rec.kind] || 'Object') + '</div>' +
        '<h3 class="sh-title">Not identified</h3>' +
        '<p class="sh-body">The match was below your confidence threshold. You can lower it in Settings.</p>';
    }

    var w = rec.wiki || {};
    var html = '<div class="sh-kicker">' + U.esc(IDENT.KICKER[rec.kind] || 'Object') + '</div>';
    html += '<h3 class="sh-title">' + U.esc(rec.name) + '</h3>';
    if (rec.scientific) html += '<p class="sh-sci">' + U.esc(rec.scientific) + '</p>';
    html += confBar(rec.confidence);
    if (w.thumb) html += '<img class="sh-hero" src="' + U.esc(w.thumb) + '" alt="" loading="lazy">';

    if (rec.kind === 'person') {
      html += facts([
        ['Known for', (w.occupations || []).slice(0, 3).join(', ')],
        ['Born', w.bornYear ? String(w.bornYear) : '']
      ]);
    } else if (rec.kind === 'plant' || rec.kind === 'animal' || rec.kind === 'insect') {
      html += facts([['Rank', w.rank], ['Conservation', w.conservation]]);
    } else {
      html += facts([['Made by', w.maker], ['Since', w.from]]);
    }

    var body = w.extract || rec.note || '';
    if (body) html += '<p class="sh-body">' + U.esc(body.slice(0, 520)) + (body.length > 520 ? '…' : '') + '</p>';

    html += '<div class="sh-actions">';
    html += linkBtn(w.url, 'Wikipedia', true);
    html += linkBtn(w.website, 'Official site');
    html += '</div>';

    if (rec.alt && rec.alt.length) {
      html += '<p class="sh-note">Other possibilities: ' + U.esc(rec.alt.slice(0, 3).join(', ')) + '</p>';
    }
    if (!w.url) html += '<p class="sh-note">No encyclopedia page was found for this one, so the description comes from the model and may be less reliable.</p>';
    return html;
  }

  function openRecord(rec) { showSheet(record(rec)); }

  function openTrack(t) {
    openTrackId = t.id;
    if (t.state === 'done' && t.data) { showSheet(record(t.data)); return; }
    if (t.state === 'queued') { openPending('Identifying ' + U.titleCase(t.cls) + '…'); return; }
    if (t.state === 'skipped' && t.reason === 'faces-off') { showSheet(gatedPerson({ kind: 'person', gated: 'faces-off' })); return; }
    if (t.state === 'failed') { openError(t.reason || ''); return; }
    /* Not yet queued: ask for it now rather than making the user wait. */
    t.state = 'new';
    IDENT.forTrack(t);
    openPending('Identifying ' + U.titleCase(t.cls) + '…');
  }

  /* If the sheet is showing a track that has since been identified, refresh it. */
  function refreshOpen() {
    if (openTrackId == null || sheet.hidden) return;
    var t = TRACK.byId(openTrackId);
    if (t && t.state === 'done' && t.data) showSheet(record(t.data));
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
    meta.textContent = last && last.pending ? 'translating…' : (last && last.note ? last.note : '');
    bar.hidden = false;
  }

  function captionState(s) {
    var btn = U.$('#btnCaptions');
    btn.setAttribute('aria-pressed', s === 'listening' || s === 'paused' ? 'true' : 'false');
    var meta = U.$('#capMeta');
    if (s === 'denied') meta.textContent = 'microphone blocked';
    else if (s === 'error') meta.textContent = 'caption error';
    if (s === 'off') U.$('#captionBar').hidden = true;
  }

  /* ---------- settings ---------- */

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
    U.$('#buildLine').textContent = 'Sightline - local detection runs in this browser; only cropped regions are ever sent for identification.';

    if (!CAPS.supported()) {
      U.$('#btnCaptions').style.opacity = '.45';
      U.$('#btnCaptions').title = 'This browser has no speech recognition';
    }
  }

  function wire() {
    U.$('#btnSettings').addEventListener('click', function () { settings.hidden = false; });
    U.$('#settingsClose').addEventListener('click', function () { settings.hidden = true; });
    U.$('#sheetClose').addEventListener('click', closeSheet);

    U.$('#apiBase').addEventListener('change', function () {
      SET.set('apiBase', this.value.trim());
      U.$('#apiStatus').textContent = '';
      U.$('#apiStatus').className = 'status';
    });

    U.$('#btnTest').addEventListener('click', function () {
      var s = U.$('#apiStatus');
      if (!SET.hasApi()) { s.className = 'status bad'; s.textContent = 'Enter a full https:// URL first.'; return; }
      s.className = 'status wait'; s.textContent = 'Checking…';
      U.fetchT(SET.api('/v1/health'), {}, 9000)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) throw new Error('bad');
          var f = j.features || {};
          var on = Object.keys(f).filter(function (k) { return f[k]; });
          s.className = 'status ok';
          s.textContent = 'Connected. Available: ' + (on.length ? on.join(', ') : 'nothing configured yet');
        })
        .catch(function () {
          s.className = 'status bad';
          s.textContent = 'No response. Check the URL is your deployed Worker.';
        });
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

    U.$$('.dockbtn[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        U.$$('.dockbtn[data-mode]').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        SET.set('mode', b.dataset.mode);
        TRACK.reset();
        dirty();
      });
    });

    U.$('#btnCaptions').addEventListener('click', function () {
      if (CAPS.running()) { CAPS.stop(); CAPS.clear(); }
      else { CAPS.start(); }
    });

    U.$('#btnFlip').addEventListener('click', function () {
      CAM.flip().then(function () { SET.set('facing', CAM.current()); TRACK.reset(); dirty(); });
    });

    /* Tap: a track if one is under the finger, otherwise identify that spot. */
    U.$('#stage').addEventListener('click', function (ev) {
      if (!CAM.live()) return;
      if (ev.target.closest('#dock,#topbar,#sheet,#settings,#gate,#captionBar')) return;
      var r = cv.getBoundingClientRect();
      var x = ev.clientX - r.left, y = ev.clientY - r.top;
      var t = TRACK.hit(x, y);
      if (t) openTrack(t); else IDENT.atPoint(x, y);
    });
  }

  return { init: init, draw: draw, dirty: dirty, resize: resize,
           openTrack: openTrack, openRecord: openRecord, openPending: openPending,
           openError: openError, needEndpoint: needEndpoint, close: closeSheet,
           refreshOpen: refreshOpen, captionDraw: captionDraw, captionState: captionState,
           get needsDraw() { return needsDraw; } };
})();
