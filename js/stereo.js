/* stereo.js - the whole app, in two views, for a cardboard viewer.

   "add vr button that makes whole thing 2 views"

   Not just the games. The camera and every label, box, arrow and leader
   line Sightline draws, rendered twice side by side, so the phone can go
   in a viewer and the app can be WORN.

   HOW, AND WHY THIS WAY. Everything worth seeing is already on two
   surfaces: the video, and the #overlay canvas the AR is drawn on. Both
   are things a canvas can draw, so stereo is a compositor - one more
   canvas on top that blits those two into a left half and a right half
   each frame. Nothing about the AR pipeline changes, nothing is drawn
   twice by the app itself, and a label added to the overlay tomorrow
   appears in both eyes without knowing this file exists.

   ⚠ THE DOM HUD CANNOT COME WITH IT, and pretending otherwise would be
   the mistake here. The dock, the readouts and the sheets are elements,
   not pixels; there is no honest way to put one element in two places at
   once, and a second copy of the app in an iframe would want a second
   camera the phone does not have. So VR mode HIDES the chrome and draws
   what matters - the status line and the thing being looked at - into
   both eyes itself. The exit is a bar across the bottom of both halves,
   reachable with a thumb without taking the phone out.

   THE OFFSET IS NOT A DEPTH SIMULATION. One camera cannot give two eyes
   real parallax. What the small horizontal shift does is put the two
   pictures where a viewer's lenses expect them, so they FUSE instead of
   fighting; the world stays as flat as one lens can see it. Said plainly
   rather than sold as 3D.                                              */

var STEREO = (function () {
  'use strict';

  var root = null, cv = null, ctx = null, raf = 0, on = false;
  var GAP = 0.012;            // eye offset, as a fraction of one half's width
  var listeners = [];

  function running() { return on; }
  function watch(fn) { listeners.push(fn); }
  function fire(ev) { listeners.forEach(function (f) { try { f(ev); } catch (e) {} }); }

  function start() {
    if (on) return true;
    if (!window.CAM || !CAM.live || !CAM.live()) return false;
    build();
    on = true;
    document.body.classList.add('vr-mode');
    /* The viewer covers the screen, so a lock is the difference between a
       game and a black rectangle two minutes in. */
    lockAwake(true);
    raf = requestAnimationFrame(tick);
    fire({ kind: 'on' });
    return true;
  }

  function stop() {
    if (!on) return;
    on = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    document.body.classList.remove('vr-mode');
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null; cv = null; ctx = null;
    lockAwake(false);
    fire({ kind: 'off' });
  }

  function toggle() { return on ? (stop(), false) : start(); }

  /* Keeping the screen on. Wake Lock where there is one, and nothing
     pretended where there is not. */
  var lock = null;
  function lockAwake(want) {
    try {
      if (want && navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (l) { lock = l; }, function () {});
      } else if (!want && lock) { lock.release(); lock = null; }
    } catch (e) {}
  }

  function build() {
    root = document.createElement('div');
    root.id = 'vrStereo';
    cv = document.createElement('canvas');
    cv.id = 'vrStereoCv';
    root.appendChild(cv);

    var out = document.createElement('button');
    out.id = 'vrStereoOut';
    out.type = 'button';
    out.textContent = 'EXIT VR';
    out.addEventListener('click', stop);
    root.appendChild(out);

    document.body.appendChild(root);
    size();
    window.addEventListener('resize', size);
  }

  function size() {
    if (!cv) return;
    var r = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(cv.clientWidth * r);
    cv.height = Math.round(cv.clientHeight * r);
    ctx = cv.getContext('2d');
    ctx.setTransform(r, 0, 0, r, 0, 0);
  }

  function tick() {
    if (!on) return;
    raf = requestAnimationFrame(tick);
    draw();
  }

  function draw() {
    if (!ctx || !cv) return;
    var w = cv.clientWidth, h = cv.clientHeight;
    var half = w / 2;
    var video = document.getElementById('cam');
    var over = document.getElementById('overlay');

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    var shift = half * GAP;
    [[0, -shift], [half, shift]].forEach(function (pair) {
      var x0 = pair[0], off = pair[1];
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, 0, half, h); ctx.clip();
      ctx.translate(x0 + off, 0);
      /* The camera, filling the half without stretching faces: whichever
         way it has to be cropped, it is cropped the same in both eyes or
         they will not fuse. */
      if (video && video.videoWidth) {
        var vr = video.videoWidth / video.videoHeight, hr = half / h;
        var dw = half, dh = h, dx = 0, dy = 0;
        if (vr > hr) { dw = h * vr; dx = (half - dw) / 2; }
        else { dh = half / vr; dy = (h - dh) / 2; }
        try { ctx.drawImage(video, dx, dy, dw, dh); } catch (e) {}
      }
      /* And the app's own drawing on top, at the same size as the half so
         a box still sits on the thing it is around. */
      if (over && over.width) {
        try { ctx.drawImage(over, 0, 0, half, h); } catch (e) {}
      }
      ctx.restore();
    });

    /* THE HUD, DRAWN RATHER THAN BORROWED. Two lines, both eyes: what the
       app is doing, and what it is looking at. Anything longer cannot be
       read through a plastic lens anyway. */
    var top = hudTop(), mid = hudMid();
    [[0], [half]].forEach(function (pair) {
      var x0 = pair[0];
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, 0, half, h); ctx.clip();
      ctx.translate(x0, 0);
      ctx.textAlign = 'center';
      if (top) {
        ctx.fillStyle = 'rgba(4,8,14,.66)';
        ctx.fillRect(half * 0.06, 12, half * 0.88, 24);
        ctx.fillStyle = 'rgba(230,240,250,.92)';
        ctx.font = '600 11px ui-monospace,Menlo,monospace';
        ctx.fillText(top, half / 2, 28);
      }
      if (mid) {
        ctx.fillStyle = 'rgba(230,240,250,.95)';
        ctx.font = '600 13px -apple-system,system-ui,sans-serif';
        ctx.fillText(mid, half / 2, h - 74);
      }
      /* A reticle, because in a viewer there is no finger to point with
         and the middle of the view is what you aim. */
      ctx.strokeStyle = 'rgba(79,227,255,.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(half / 2, h / 2, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    });
  }

  /* Read from the elements the app already keeps up to date rather than
     from a second copy of the same facts. */
  function hudTop() {
    var el = document.getElementById('statusText');
    var t = el ? (el.textContent || '').trim() : '';
    return t.slice(0, 46);
  }
  function hudMid() {
    var el = document.getElementById('hudTL');
    var t = el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    return t.slice(0, 40);
  }

  return { start: start, stop: stop, toggle: toggle, running: running, on: watch,
           _draw: draw, _size: size };
})();
