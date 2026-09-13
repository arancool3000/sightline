/* Sightline - games you play with your hands, through a cardboard viewer.

   "i am planning on putting phone in cardboard box for fun and using
    camera to detect my hand. i want games like a cool immersive cube
    slicing game so you have swords in your hands in vr and cubes are
    going towards you and you have to slice them."

   Three parts, and the first is the one that decides whether any of this
   is fun:

   HANDS, WITHOUT A MODEL. There is no hand-tracking model in this app and
   downloading one would put a game behind eight megabytes and a network.
   It does not need one: in a viewer the rear camera looks where you look,
   your hands come up from below into a known half of the frame each, and
   what separates a hand from a room is that it is skin-coloured and
   moving. So each half of the lower frame gets a skin mask in YCbCr -
   which is the classic test because chroma barely moves across skin tones
   while luma does all the work - and the centroid of what it finds is the
   hand. Cheap, offline, no key, no download, and accurate enough to swing
   a sword with.

   STEREO, THE HONEST KIND. Two viewports with the eyes about 62mm apart,
   each rendering the same world from its own place. That is what makes a
   cube look like it is coming at your face rather than growing.

   A GAME LOOP THAT IS ITS OWN THING. GAMES is a table; slice is the first
   entry. "we add more later" - so a second game is an entry, not a
   rewrite.                                                              */
var VR = (function () {

  /* ---- hands ---- */

  var hpad = null, hctx = null;
  var HW = 64, HH = 48;                 // the mask is tiny on purpose
  var hands = {
    left:  { x: 0.3, y: 0.6, vx: 0, vy: 0, seen: false, n: 0 },
    right: { x: 0.7, y: 0.6, vx: 0, vy: 0, seen: false, n: 0 }
  };
  var SMOOTH = 0.45;                    // how much of a new reading to believe
  var MIN_PIX = 14;                     // fewer than this is noise, not a hand

  /* Skin in YCbCr. The luma term is deliberately loose - a hand in shadow
     is still a hand - and the chroma window is what actually decides. */
  function isSkin(r, g, b) {
    var y  = 0.299 * r + 0.587 * g + 0.114 * b;
    if (y < 40 || y > 250) return false;
    var cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    var cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return cb > 77 && cb < 130 && cr > 132 && cr < 178 && r > g && r > b;
  }

  function readHands(video) {
    if (!video || !video.videoWidth) return;
    if (!hpad) { hpad = document.createElement('canvas'); hpad.width = HW; hpad.height = HH;
                 hctx = hpad.getContext('2d', { willReadFrequently: true }); }
    try { hctx.drawImage(video, 0, 0, HW, HH); } catch (e) { return; }
    var d;
    try { d = hctx.getImageData(0, 0, HW, HH).data; } catch (e) { return; }   // tainted

    /* Only the lower two thirds: hands come up from below, and the top of
       the frame is the room. */
    var y0 = Math.floor(HH * 0.32);
    var acc = { left: { sx: 0, sy: 0, n: 0 }, right: { sx: 0, sy: 0, n: 0 } };
    for (var py = y0; py < HH; py++) {
      for (var px = 0; px < HW; px++) {
        var i = (py * HW + px) * 4;
        if (!isSkin(d[i], d[i + 1], d[i + 2])) continue;
        var side = px < HW / 2 ? acc.left : acc.right;
        side.sx += px; side.sy += py; side.n++;
      }
    }
    ['left', 'right'].forEach(function (k) {
      var a = acc[k], h = hands[k];
      h.n = a.n;
      if (a.n < MIN_PIX) { h.seen = false; h.vx *= 0.6; h.vy *= 0.6; return; }
      var nx = (a.sx / a.n) / HW, ny = (a.sy / a.n) / HH;
      var px2 = h.x, py2 = h.y;
      h.x += (nx - h.x) * SMOOTH;
      h.y += (ny - h.y) * SMOOTH;
      h.vx = h.x - px2; h.vy = h.y - py2;
      h.seen = true;
    });
  }
  function copyHand(h) {
    return { x: h.x, y: h.y, vx: h.vx, vy: h.vy, n: h.n, seen: h.seen };
  }
  /* A copy, never the live object: a caller that holds on to a reading would
     otherwise watch it change under them on the next frame. */
  function handState() { return { left: copyHand(hands.left), right: copyHand(hands.right) }; }

  /* ---- the world ---- */

  var EYE = 0.031;                      // half the gap between your eyes, in metres
  var FOCAL = 0.9;                      // how wide the view is; smaller is wider
  var HIT_Z = 1.05;                     // where a blade lives, in front of you
  var SPAN = 2.4;                       // how much world one screen width covers

  function project(p, eye, vw, vh) {
    var z = p.z;
    if (z < 0.05) return null;
    var f = (vw * FOCAL) / z;
    return { x: vw / 2 + (p.x - eye) * f, y: vh / 2 - p.y * f, s: f };
  }
  /* A hand's screen reading, as a place in the world at blade depth. */
  function handPoint(h, vh, vw) {
    return { x: (h.x - 0.5) * SPAN, y: (0.5 - h.y) * SPAN * (vh / vw), z: HIT_Z };
  }

  /* ---- the games ---- */

  var GAMES = {
    slice: {
      title: 'Cube Slice',
      how: 'Cubes come at you. Swing a hand through one to cut it. Two hands, two swords.',
      make: function () { return sliceGame(); }
    }
  };
  function list() { return Object.keys(GAMES).map(function (k) {
    return { id: k, title: GAMES[k].title, how: GAMES[k].how }; }); }

  function sliceGame() {
    var cubes = [], bits = [], t = 0, next = 0, score = 0, combo = 0, best = 0, missed = 0;
    var SPEED = 2.2, EVERY = 0.78, BLADE = 0.34, SWING = 0.012;

    function spawn() {
      var lane = Math.random();
      cubes.push({
        x: (lane - 0.5) * SPAN * 0.72,
        y: (Math.random() * 0.5 - 0.1) * SPAN * 0.4,
        z: 9 + Math.random() * 2,
        size: 0.17 + Math.random() * 0.05,
        spin: (Math.random() - 0.5) * 2,
        hand: lane < 0.5 ? 'left' : 'right',
        cut: false
      });
    }

    return {
      score: function () { return { score: score, combo: combo, best: best, missed: missed,
                                    live: cubes.length }; },
      step: function (dt) {
        t += dt;
        if (t > next) { next = t + EVERY * (0.7 + Math.random() * 0.6); spawn(); }

        var hs = handState();
        for (var i = cubes.length - 1; i >= 0; i--) {
          var c = cubes[i];
          c.z -= SPEED * dt;
          c.spin += dt * 1.6;

          if (!c.cut && Math.abs(c.z - HIT_Z) < 0.55) {
            /* Either hand may take any cube - the lane is a hint, not a
               rule, because telling somebody which hand to use is how a
               game stops being fun. */
            ['left', 'right'].forEach(function (k) {
              if (c.cut) return;
              var h = hs[k];
              if (!h.seen) return;
              var speed = Math.sqrt(h.vx * h.vx + h.vy * h.vy);
              if (speed < SWING) return;                 // resting, not swinging
              var p = handPoint(h, 1, 1);
              if (Math.abs(p.x - c.x) > c.size + BLADE) return;
              if (Math.abs(p.y - c.y) > c.size + BLADE) return;
              c.cut = true;
              score += 10 + combo * 2;
              combo++;
              if (combo > best) best = combo;
              var ang = Math.atan2(h.vy, h.vx);
              bits.push({ x: c.x, y: c.y, z: c.z, size: c.size, life: 1,
                          vx: Math.cos(ang) * 0.8, vy: -Math.sin(ang) * 0.8, spin: c.spin });
              bits.push({ x: c.x, y: c.y, z: c.z, size: c.size, life: 1,
                          vx: -Math.cos(ang) * 0.8, vy: Math.sin(ang) * 0.8, spin: -c.spin });
              cubes.splice(i, 1);
            });
          }
          if (!c.cut && c.z < 0.2) { cubes.splice(i, 1); missed++; combo = 0; }
        }
        for (var j = bits.length - 1; j >= 0; j--) {
          var b = bits[j];
          b.life -= dt * 1.6;
          b.x += b.vx * dt; b.y += b.vy * dt; b.z -= SPEED * dt * 0.4;
          if (b.life <= 0) bits.splice(j, 1);
        }
      },
      draw: function (ctx, eye, vw, vh) {
        /* Floor lines, so there is somewhere for the cubes to come FROM.
           Without them a cube growing on a black field is just a growing
           square. */
        ctx.strokeStyle = 'rgba(79,227,255,.18)';
        ctx.lineWidth = 1;
        for (var g = 1; g <= 9; g++) {
          var a = project({ x: -SPAN, y: -0.62, z: g }, eye, vw, vh);
          var b2 = project({ x: SPAN, y: -0.62, z: g }, eye, vw, vh);
          if (!a || !b2) continue;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
        }

        cubes.slice().sort(function (p, q) { return q.z - p.z; }).forEach(function (c) {
          cube(ctx, c, eye, vw, vh, c.hand === 'left' ? '#4fe3ff' : '#ff7ad4', 1);
        });
        bits.forEach(function (b) {
          cube(ctx, b, eye, vw, vh, '#9fb6c8', Math.max(0, b.life));
        });

        /* The swords. Anchored low and to the side, so they read as being
           held rather than floating. */
        var hs = handState();
        [['left', -0.34], ['right', 0.34]].forEach(function (pair) {
          var h = hs[pair[0]];
          if (!h.seen) return;
          var tip = handPoint(h, vh, vw);
          var grip = { x: pair[1], y: -0.55, z: HIT_Z + 0.5 };
          var a = project(grip, eye, vw, vh), b3 = project(tip, eye, vw, vh);
          if (!a || !b3) return;
          ctx.strokeStyle = 'rgba(255,255,255,.9)';
          ctx.lineWidth = Math.max(3, 10 / tip.z);
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b3.x, b3.y); ctx.stroke();
          ctx.strokeStyle = pair[0] === 'left' ? 'rgba(79,227,255,.55)' : 'rgba(255,122,212,.55)';
          ctx.lineWidth = Math.max(7, 20 / tip.z);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b3.x, b3.y); ctx.stroke();
        });
      }
    };
  }

  /* A cube as a front face and the four edges running back to it: enough
     to read as a box, and cheap enough to draw sixty of. */
  function cube(ctx, c, eye, vw, vh, colour, alpha) {
    var s = c.size;
    var f = project({ x: c.x, y: c.y, z: c.z }, eye, vw, vh);
    var bk = project({ x: c.x, y: c.y, z: c.z + s * 1.6 }, eye, vw, vh);
    if (!f) return;
    var w = s * f.s, cs = Math.cos(c.spin) * 0.18, sn = Math.sin(c.spin) * 0.18;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (bk) {
      var w2 = s * bk.s;
      ctx.strokeStyle = colour; ctx.globalAlpha = alpha * 0.28; ctx.lineWidth = 1.5;
      ctx.strokeRect(bk.x - w2, bk.y - w2, w2 * 2, w2 * 2);
      ctx.beginPath();
      ctx.moveTo(f.x - w, f.y - w); ctx.lineTo(bk.x - w2, bk.y - w2);
      ctx.moveTo(f.x + w, f.y - w); ctx.lineTo(bk.x + w2, bk.y - w2);
      ctx.moveTo(f.x - w, f.y + w); ctx.lineTo(bk.x - w2, bk.y + w2);
      ctx.moveTo(f.x + w, f.y + w); ctx.lineTo(bk.x + w2, bk.y + w2);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha * 0.22;
    ctx.fillStyle = colour;
    ctx.fillRect(f.x - w, f.y - w + sn * w, w * 2, w * 2);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1.5, 3 / c.z);
    ctx.strokeRect(f.x - w, f.y - w + sn * w, w * 2, w * 2);
    ctx.globalAlpha = alpha * 0.5;
    ctx.beginPath();
    ctx.moveTo(f.x - w * 0.5 + cs * w, f.y); ctx.lineTo(f.x + w * 0.5 + cs * w, f.y);
    ctx.stroke();
    ctx.restore();
  }

  /* ---- running one ---- */

  var root = null, cv = null, ctx = null, game = null, id = '', raf = 0, last = 0;
  var listeners = [];
  function on(fn) { listeners.push(fn); }
  function fire(ev) { listeners.forEach(function (f) { try { f(ev); } catch (e) {} }); }

  function running() { return !!game; }
  function current() { return id; }
  function score() { return game ? game.score() : null; }

  function start(which) {
    var key = String(which || 'slice').toLowerCase();
    if (!GAMES[key]) return false;
    if (game) stop();
    if (!window.CAM || !CAM.live || !CAM.live()) return false;
    id = key;
    game = GAMES[key].make();
    build();
    last = performance.now();
    raf = requestAnimationFrame(tick);
    fire({ kind: 'start', game: key });
    return true;
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    var was = game ? game.score() : null;
    game = null;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null; cv = null; ctx = null;
    if (was) fire({ kind: 'end', game: id, score: was });
    id = '';
  }

  function build() {
    root = document.createElement('div');
    root.id = 'vrRoot';
    cv = document.createElement('canvas');
    cv.id = 'vrCanvas';
    var out = document.createElement('button');
    out.id = 'vrOut'; out.className = 'hbtn'; out.textContent = 'LEAVE';
    out.addEventListener('click', stop);
    root.appendChild(cv); root.appendChild(out);
    document.body.appendChild(root);
    size();
    window.addEventListener('resize', size);
  }
  function size() {
    if (!cv) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
    ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function tick(now) {
    if (!game) return;
    raf = requestAnimationFrame(tick);
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    readHands(document.getElementById('cam'));
    game.step(dt);
    draw();
  }

  function draw() {
    if (!ctx || !cv) return;
    var w = cv.clientWidth, h = cv.clientHeight;
    var vw = w / 2;
    ctx.fillStyle = '#04070b';
    ctx.fillRect(0, 0, w, h);
    /* Two eyes, two viewports, one world. */
    [[-EYE, 0], [EYE, vw]].forEach(function (pair) {
      ctx.save();
      ctx.beginPath(); ctx.rect(pair[1], 0, vw, h); ctx.clip();
      ctx.translate(pair[1], 0);
      game.draw(ctx, pair[0], vw, h);
      ctx.restore();
    });
    /* The score sits between the eyes, where both can read it. */
    var s = game.score();
    ctx.save();
    ctx.fillStyle = 'rgba(230,240,250,.9)';
    ctx.font = '600 13px ui-monospace,Menlo,monospace';
    ctx.textAlign = 'center';
    ctx.fillText(s.score + '   x' + s.combo, w / 2, 22);
    var hs = handState();
    if (!hs.left.seen && !hs.right.seen) {
      ctx.fillStyle = 'rgba(230,240,250,.7)';
      ctx.font = '600 12px -apple-system,system-ui,sans-serif';
      ctx.fillText('Hold your hands up in front of the camera', w / 2, h - 24);
    }
    ctx.restore();
  }

  return { start: start, stop: stop, running: running, current: current, score: score,
           list: list, on: on, GAMES: GAMES,
           _hands: handState, _readHands: readHands, _isSkin: isSkin,
           _setHand: function (k, o) { var h = hands[k]; if (h) for (var f in o) h[f] = o[f]; },
           _project: project, _handPoint: handPoint, _draw: draw };
})();
