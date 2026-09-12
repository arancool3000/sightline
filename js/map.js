/* Sightline - the map.

   Drawn, not tiled. There is no tile server behind this and no key: the
   picture is your position at the centre, the compass ring around it, and
   everything Wikipedia knows the location of within a few hundred metres,
   plotted at its real bearing and distance. That is a map that cannot be
   rate-limited, cannot be metered and works the same on the thousandth
   look as the first.

   Two sizes. The disc lives in the corner of the HUD. Tapping it opens the
   panel, which is the same drawing larger, with the places listed and each
   one openable. */
'use strict';

var MAP = (function () {

  var disc = null, dctx = null, panel = null, pctx = null;
  var range = 500;                    // metres from the centre to the outer ring
  var RANGES = [250, 500, 1000, 3000];
  var open = false, dpr = 1;
  var sel = null;

  function init() {
    disc = document.getElementById('radar');
    panel = document.getElementById('mapCanvas');
    if (disc) dctx = disc.getContext('2d');
    if (panel) pctx = panel.getContext('2d');
    dpr = Math.min(window.devicePixelRatio || 1, 2);

    var pod = document.getElementById('radarPod');
    if (pod) pod.addEventListener('click', function () {
      GEO.askCompass();
      setOpen(!open);
    });
    var close = document.getElementById('mapClose');
    if (close) close.addEventListener('click', function () { setOpen(false); });
    var rng = document.getElementById('mapRange');
    if (rng) rng.addEventListener('click', function () {
      range = RANGES[(RANGES.indexOf(range) + 1) % RANGES.length];
      rng.textContent = label(range);
      draw();
    });
    if (panel) panel.addEventListener('click', pick);

    GEO.on(function () { draw(); fillList(); });
    size();
    window.addEventListener('resize', function () { size(); draw(); });
    draw();
  }

  function label(m) { return m >= 1000 ? (m / 1000) + ' KM' : m + ' M'; }

  function size() {
    [[disc, dctx], [panel, pctx]].forEach(function (p) {
      var c = p[0], x = p[1];
      if (!c || !x) return;
      var w = c.clientWidth || 96, h = c.clientHeight || 96;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
  }

  function setOpen(v) {
    open = v;
    var el = document.getElementById('mapPanel');
    if (el) el.hidden = !v;
    if (v) { size(); GEO.refresh(); fillList(); }
    draw();
  }

  /* One drawing routine for both sizes: the small one just leaves out the
     labels it has no room for. */
  function paint(ctx, w, h, big) {
    var s = GEO.state();
    var cx = w / 2, cy = h / 2;
    var R = Math.min(w, h) / 2 - (big ? 26 : 5);
    ctx.clearRect(0, 0, w, h);

    var acc = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#4fe3ff';
    var faint = 'rgba(230,236,241,.22)';

    /* Rings, at a quarter, a half and the full range. */
    ctx.save();
    ctx.strokeStyle = faint; ctx.lineWidth = 1;
    [0.34, 0.67, 1].forEach(function (f) {
      ctx.globalAlpha = f === 1 ? 0.5 : 0.26;
      ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.globalAlpha = 0.18;
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ctx.restore();

    /* Heading-up: the top of the disc is where the camera is pointed, which
       is the only orientation that lets you walk toward a blip. North is
       marked so the rotation is legible rather than mysterious. */
    var head = (typeof s.heading === 'number') ? s.heading : 0;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-head * Math.PI / 180);
    ctx.fillStyle = acc;
    ctx.font = (big ? '600 11px ' : '600 9px ') + 'ui-monospace,Menlo,monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.75;
    ctx.fillText('N', 0, -R + (big ? 12 : 7));
    if (big) {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#e6ecf1';
      ctx.fillText('E', R - 12, 0); ctx.fillText('S', 0, R - 12); ctx.fillText('W', -R + 12, 0);
    }
    ctx.restore();

    /* The places. */
    var hits = [];
    if (s.pos) {
      s.places.forEach(function (p) {
        if (p.dist > range) return;
        var rel = ((p.bearing - head) + 360) % 360;
        var rad = rel * Math.PI / 180;
        var d = (p.dist / range) * R;
        var x = cx + Math.sin(rad) * d, y = cy - Math.cos(rad) * d;
        hits.push({ p: p, x: x, y: y });
      });
    }

    hits.forEach(function (b) {
      var on = sel && sel.title === b.p.title;
      ctx.save();
      ctx.fillStyle = on ? '#ffb347' : acc;
      ctx.globalAlpha = on ? 1 : 0.85;
      ctx.beginPath(); ctx.arc(b.x, b.y, big ? (on ? 5 : 3.5) : 2.2, 0, Math.PI * 2); ctx.fill();
      if (big) {
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = on ? '#ffb347' : acc; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(b.x, b.y, on ? 11 : 8, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    });

    /* Only the nearest few get a name, and only on the big one: a disc full
       of overlapping text is a worse map than a disc of dots. */
    if (big) {
      hits.slice(0, 6).forEach(function (b) {
        ctx.save();
        ctx.font = '500 10px ui-monospace,Menlo,monospace';
        ctx.fillStyle = 'rgba(230,236,241,.82)';
        ctx.textAlign = b.x > cx ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        var t = b.p.title.length > 22 ? b.p.title.slice(0, 21) + '…' : b.p.title;
        ctx.fillText(t, b.x + (b.x > cx ? 9 : -9), b.y);
        ctx.restore();
      });
    }

    /* You, and which way you are facing. */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = acc;
    ctx.beginPath();
    ctx.moveTo(0, big ? -10 : -6);
    ctx.lineTo(big ? 6.5 : 4, big ? 7 : 4.5);
    ctx.lineTo(0, big ? 3.5 : 2);
    ctx.lineTo(big ? -6.5 : -4, big ? 7 : 4.5);
    ctx.closePath();
    ctx.fill();
    if (s.pos && s.pos.acc) {
      var ar = Math.min(R, (s.pos.acc / range) * R);
      if (ar > 3) {
        ctx.globalAlpha = 0.13; ctx.fillStyle = acc;
        ctx.beginPath(); ctx.arc(0, 0, ar, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    /* Nothing to plot is a state, not a blank disc. */
    if (!s.pos) {
      ctx.save();
      ctx.font = (big ? '500 11px ' : '500 8px ') + 'ui-monospace,Menlo,monospace';
      ctx.fillStyle = 'rgba(230,236,241,.5)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(big ? (s.error ? s.error.toUpperCase() : 'FINDING YOU…') : 'GPS', cx, cy + (big ? 26 : 15));
      ctx.restore();
    }
    return hits;
  }

  var lastHits = [];

  function draw() {
    if (dctx && disc) paint(dctx, disc.clientWidth || 96, disc.clientHeight || 96, false);
    if (open && pctx && panel) lastHits = paint(pctx, panel.clientWidth, panel.clientHeight, true);
    var s = GEO.state();
    var pod = document.getElementById('radarNote');
    if (pod) {
      var txt = s.pos ? (s.locality ? s.locality.toUpperCase().slice(0, 16) : 'NO LANDMARKS')
                      : (s.error ? 'NO GPS' : 'LOCATING');
      if (pod.textContent !== txt) pod.textContent = txt;
    }
  }

  function pick(ev) {
    var r = panel.getBoundingClientRect();
    var x = ev.clientX - r.left, y = ev.clientY - r.top;
    var best = null, bd = 26;
    lastHits.forEach(function (b) {
      var d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b.p; }
    });
    if (best) { sel = best; draw(); fillList(); }
  }

  function fillList() {
    var box = document.getElementById('mapList');
    if (!box || !open) return;
    var s = GEO.state();
    var near = s.places.filter(function (p) { return p.dist <= range; }).slice(0, 12);
    if (!near.length) {
      box.textContent = s.pos ? 'Nothing named within ' + label(range).toLowerCase() + '.'
                              : (s.error || 'Waiting for a position.');
      return;
    }
    box.textContent = '';
    near.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'map-row' + (sel && sel.title === p.title ? ' on' : '');
      b.innerHTML = '<span class="mr-b">' + String(Math.round(p.bearing)).padStart(3, '0') + '°</span>' +
                    '<span class="mr-t"></span>' +
                    '<span class="mr-d">' + (p.dist < 1000 ? p.dist + ' m' : (p.dist / 1000).toFixed(1) + ' km') + '</span>';
      b.querySelector('.mr-t').textContent = p.title;
      b.addEventListener('click', function () {
        sel = p; draw(); fillList();
        if (window.UI && UI.openPlace) UI.openPlace(p);
      });
      box.appendChild(b);
    });
  }

  return { init: init, draw: draw, setOpen: setOpen, isOpen: function () { return open; },
           range: function () { return range; } };
})();
