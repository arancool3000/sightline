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
    if (disc) { disc.width = 112; disc.height = 112; }
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
    ROADS.on(function () { draw(); });
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

  /* THE PROJECTION.

     Both sizes share one drawing routine. The small disc is a plan view -
     at 56 pixels a tilted view is illegible - and the panel is tilted into
     perspective, which is what makes it read as ground in front of you
     rather than a diagram beside you.

     The tilt is a single shear: a point's distance ahead is compressed
     toward a horizon, so what is near you is large and what is far is
     small. It is not a 3D engine and does not pretend to be; it is the
     projection a car's navigation view uses, and it is enough.

     Heading-up, always. It is the only orientation you can walk with.    */
  /* A real perspective divide, not a skew.

     The camera sits a little behind you and above the ground, looking the
     way you are facing. A point on the ground at distance z from the camera
     lands at focal/z of the way down from the horizon - which is what makes
     the near kerb wide and the far end of the street narrow, and what a
     skewed flat grid can never look like.

     Everything is in metres until the last line.                          */
  var EYE_BACK = 0.30;      // camera behind you, as a fraction of the range
  var EYE_UP = 0.42;        // and above the ground
  var HORIZON = 0.74;       // how far up the panel the horizon sits, of R

  function ground(right, forward, R, cx, cy, range) {
    var eye = range * EYE_BACK, up = range * EYE_UP;
    var z = forward + eye;
    if (z < range * 0.04) return null;              // at or behind the camera
    var focal = R * 1.35;
    var horizonY = cy - R * HORIZON;
    return [cx + (right / z) * focal, horizonY + (up / z) * focal];
  }
  function paint(ctx, w, h, big) {
    var s = GEO.state();
    var cx = w / 2, cy = big ? h * 0.62 : h / 2;
    var R = Math.min(w, big ? h * 0.8 : h) / 2 - (big ? 18 : 4);
    ctx.clearRect(0, 0, w, h);

    var acc = '#4fe3ff';
    var head = (typeof s.heading === 'number') ? s.heading : 0;

    /* East/north metres -> screen, rotated so the way you face is "ahead". */
    function place(dEast, dNorth) {
      var a = head * Math.PI / 180;
      var right = dEast * Math.cos(a) - dNorth * Math.sin(a);
      var fwd = dEast * Math.sin(a) + dNorth * Math.cos(a);
      if (!big) {
        /* The disc is a plan view: at 56 pixels a tilted one is illegible. */
        return [cx + (right / range) * R, cy - (fwd / range) * R];
      }
      return ground(right, fwd, R, cx, cy, range);
    }

    /* Everything is drawn inside the panel; a road running off the edge of
       a perspective view reads as a glitch. */
    ctx.save();
    ctx.beginPath();
    if (big) ctx.rect(0, cy - R * HORIZON, w, h - (cy - R * HORIZON));
    else ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    if (big) {
      /* The ground itself, so the horizon is visible before anything stands
         on it. */
      var horizonY = cy - R * HORIZON;
      var g = ctx.createLinearGradient(0, horizonY, 0, h);
      g.addColorStop(0, 'rgba(20,52,84,.06)');
      g.addColorStop(1, 'rgba(24,70,110,.34)');
      ctx.fillStyle = g;
      ctx.fillRect(0, horizonY, w, h - horizonY);
      ctx.strokeStyle = 'rgba(140,200,255,.22)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, horizonY + 0.5); ctx.lineTo(w, horizonY + 0.5); ctx.stroke();
    }

    /* ---- the roads ---- */
    var drewRoads = 0;
    if (s.pos) {
      ROADS.ensure(s.pos.lat, s.pos.lon);
      var ways = ROADS.near(s.pos.lat, s.pos.lon);
      var mPerLat = 111320, mPerLon = 111320 * Math.cos(s.pos.lat * Math.PI / 180);
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ways.forEach(function (way) {
        var pts = [], any = false;
        for (var i = 0; i < way.pts.length; i++) {
          var dN = (way.pts[i][0] - s.pos.lat) * mPerLat;
          var dE = (way.pts[i][1] - s.pos.lon) * mPerLon;
          if (Math.abs(dN) > range * 3 || Math.abs(dE) > range * 3) { pts.push(null); continue; }
          var xy = place(dE, dN);
          if (!xy) { pts.push(null); continue; }     // behind the camera
          any = true;
          pts.push(xy);
        }
        if (!any) return;
        drewRoads++;
        var lw = ROADS.width(way.k) * (big ? 1.15 : 0.5);
        /* A casing under the fill is what makes a road read as a road
           rather than a line. */
        [['rgba(8,16,26,.85)', lw + (big ? 2.6 : 1)], ['rgba(150,205,255,.5)', lw]]
          .forEach(function (pass) {
            ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1];
            ctx.beginPath();
            var pen = false;
            pts.forEach(function (p) {
              if (!p) { pen = false; return; }
              if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; }
              else ctx.lineTo(p[0], p[1]);
            });
            ctx.stroke();
          });
      });
      ctx.restore();
    }

    /* ---- distance rings, on the ground ---- */
    ctx.save();
    ctx.strokeStyle = 'rgba(200,230,255,.25)';
    ctx.lineWidth = 1;
    [0.34, 0.67, 1].forEach(function (f) {
      ctx.globalAlpha = f === 1 ? 0.4 : 0.22;
      ctx.beginPath();
      var pen = false;
      for (var a = 0; a <= 360; a += 4) {
        var rad = a * Math.PI / 180;
        var p = place(Math.sin(rad) * range * f, Math.cos(rad) * range * f);
        if (!p) { pen = false; continue; }
        if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; } else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
    });
    ctx.restore();

    /* ---- the places ---- */
    var hits = [];
    if (s.pos) {
      s.places.forEach(function (p) {
        if (p.dist > range) return;
        var rad = p.bearing * Math.PI / 180;
        var xy = place(Math.sin(rad) * p.dist, Math.cos(rad) * p.dist);
        hits.push({ p: p, x: xy[0], y: xy[1] });
      });
    }
    hits.forEach(function (b) {
      var on = sel && sel.title === b.p.title;
      ctx.save();
      ctx.fillStyle = on ? '#ffb347' : acc;
      ctx.globalAlpha = on ? 1 : 0.9;
      ctx.beginPath(); ctx.arc(b.x, b.y, big ? (on ? 5 : 3.5) : 2.2, 0, Math.PI * 2); ctx.fill();
      if (big) {
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = on ? '#ffb347' : acc; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(b.x, b.y, on ? 11 : 8, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    });

    if (big) {
      hits.slice(0, 6).forEach(function (b) {
        ctx.save();
        ctx.font = '500 10px -apple-system,system-ui,sans-serif';
        ctx.fillStyle = 'rgba(230,236,241,.85)';
        ctx.textAlign = b.x > cx ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        var t = b.p.title.length > 20 ? b.p.title.slice(0, 19) + '…' : b.p.title;
        ctx.fillText(t, b.x + (b.x > cx ? 9 : -9), b.y);
        ctx.restore();
      });
    }

    /* ---- the route, as chevrons on the ground ---- */
    if (big && sel && s.pos) {
      var brg = sel.bearing, dist = Math.min(sel.dist, range);
      ctx.save();
      ctx.strokeStyle = acc;
      for (var k = 1; k <= 5; k++) {
        var at = (dist / 6) * k;
        var r2 = brg * Math.PI / 180;
        var c0 = place(Math.sin(r2) * at, Math.cos(r2) * at);
        var c1 = place(Math.sin(r2) * (at + dist / 18), Math.cos(r2) * (at + dist / 18));
        var ang = Math.atan2(c1[1] - c0[1], c1[0] - c0[0]);
        var size = (big ? 13 : 6) * (1 - k * 0.12);
        ctx.globalAlpha = 0.85 - k * 0.11;
        ctx.lineWidth = 2.6;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(c0[0] - Math.cos(ang - 0.9) * size, c0[1] - Math.sin(ang - 0.9) * size);
        ctx.lineTo(c0[0], c0[1]);
        ctx.lineTo(c0[0] - Math.cos(ang + 0.9) * size, c0[1] - Math.sin(ang + 0.9) * size);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();          // end of the clip

    /* ---- north, on the rim rather than on the ground ---- */
    if (big) {
      ctx.save();
      var na = -head * Math.PI / 180;
      ctx.fillStyle = acc; ctx.globalAlpha = 0.75;
      ctx.font = '600 11px ui-monospace,Menlo,monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var rr = R * 0.86;
      ctx.fillText('N', cx + Math.sin(na) * rr, (cy - R * 0.42) - Math.cos(na) * rr * 0.34);
      ctx.restore();
    }

    /* ---- you ---- */
    ctx.save();
    var me = big ? [cx, cy + R * 0.52] : place(0, 0);
    ctx.translate(me[0], me[1]);
    if (s.pos && s.pos.acc) {
      var ar = Math.min(R, (s.pos.acc / range) * R);
      if (ar > 3) {
        ctx.globalAlpha = 0.13; ctx.fillStyle = acc;
        ctx.beginPath(); ctx.arc(0, 0, ar, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.fillStyle = acc;
    ctx.beginPath();
    ctx.moveTo(0, big ? -12 : -6);
    ctx.lineTo(big ? 7.5 : 4, big ? 8 : 4.5);
    ctx.lineTo(0, big ? 4 : 2);
    ctx.lineTo(big ? -7.5 : -4, big ? 8 : 4.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (!s.pos) {
      ctx.save();
      ctx.font = (big ? '500 12px ' : '500 8px ') + '-apple-system,system-ui,sans-serif';
      ctx.fillStyle = 'rgba(230,236,241,.55)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(big ? (s.error ? s.error : 'Finding you…') : 'GPS', cx, cy + (big ? 30 : 15));
      ctx.restore();
    } else if (big && !drewRoads) {
      ctx.save();
      ctx.font = '500 11px -apple-system,system-ui,sans-serif';
      ctx.fillStyle = 'rgba(230,236,241,.5)';
      ctx.textAlign = 'center';
      ctx.fillText(ROADS.busy() ? 'Fetching the streets…' : 'No street data held for here yet', cx, h - 8);
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
      var txt = s.pos ? (s.locality || 'No landmarks')
                      : (s.error ? 'No location' : 'Locating');
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
