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

  /* ---- hands ----

     ⚠ THE FIRST CUT WAS "VERY BAD", AND THE REASON WAS THE SHAPE OF THE
     QUESTION IT ASKED. It took the CENTROID OF EVERY SKIN-COLOURED PIXEL
     IN EACH HALF OF THE FRAME. A wooden door, a cardboard box, a beige
     wall, a patch of sunlight - all of that is skin-coloured to a chroma
     test, all of it sits still in the room, and averaging it with a real
     hand drags the reading towards the middle of the wall. Worse, it
     could never be still and never be fast: a centroid of a thousand
     static pixels barely moves when a hand crosses it, so a swing read as
     a drift. The sword lagged, wandered and pointed at furniture.

     Four changes, each aimed at one of those:

     1. MOVEMENT IS PART OF BEING A HAND. The previous frame's luma is
        kept; a skin pixel only counts if it has changed, or if it is
        close to where a hand already was. A room does not move. This is
        what removes the furniture.
     2. BLOBS, NOT AVERAGES. The mask is flood-filled and only whole
        connected regions of a plausible size count, so a hand is one blob
        and a sunlit wall is rejected for being enormous.
     3. WHICH HAND IS WHICH IS DECIDED BY WHERE THE HANDS WERE, not by
        which half of the frame a pixel is in. Two hands that cross no
        longer swap, and one hand on the wrong side is still that hand.
     4. SMOOTHING THAT GETS OUT OF THE WAY. Slow movement is smoothed hard
        so a resting hand is steady; fast movement is barely smoothed at
        all so a swing arrives on the frame it happened. Velocity comes
        from the RAW readings, because measuring the speed of a smoothed
        signal is measuring the smoothing.                              */

  var hpad = null, hctx = null, prevY = null;
  var HW = 80, HH = 60;                 // the mask is small on purpose
  var hands = {
    left:  { x: 0.3, y: 0.6, vx: 0, vy: 0, seen: false, n: 0, lost: 9 },
    right: { x: 0.7, y: 0.6, vx: 0, vy: 0, seen: false, n: 0, lost: 9 }
  };
  var MIN_PIX = 16;                     // fewer than this is noise, not a hand
  var MAX_PIX = 1100;                   // more than this is a wall, not a hand
  var MOVE_MIN = 9;                     // luma change that counts as movement
  var NEAR = 0.22;                      // how close to a known hand still counts
  var KEEP = 4;                         // frames a hand may go missing before it is gone

  /* Skin in YCbCr. The luma term is deliberately loose - a hand in shadow
     is still a hand - and the chroma window is what actually decides. */
  function isSkin(r, g, b) {
    var y  = 0.299 * r + 0.587 * g + 0.114 * b;
    if (y < 40 || y > 250) return false;
    var cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    var cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return cb > 77 && cb < 130 && cr > 132 && cr < 178 && r > g && r > b;
  }

  /* One flood fill, iterative - a recursive one blows the stack on a big
     region, and a big region is exactly the case this has to survive. */
  var stackX = null, stackY = null;
  function blobAt(mask, sx, sy, seen) {
    if (!stackX) { stackX = new Int16Array(HW * HH); stackY = new Int16Array(HW * HH); }
    var top = 0, n = 0, cx = 0, cy = 0;
    var minx = sx, maxx = sx, miny = sy, maxy = sy;
    stackX[top] = sx; stackY[top] = sy; top++;
    seen[sy * HW + sx] = 1;
    while (top > 0) {
      top--;
      var x = stackX[top], y = stackY[top];
      n++; cx += x; cy += y;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (var d = 0; d < 4; d++) {
        var nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
        var ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= HW || ny >= HH) continue;
        var i = ny * HW + nx;
        if (seen[i] || !mask[i]) continue;
        seen[i] = 1;
        stackX[top] = nx; stackY[top] = ny; top++;
      }
    }
    return { n: n, x: (cx / n) / HW, y: (cy / n) / HH,
             w: (maxx - minx + 1) / HW, h: (maxy - miny + 1) / HH };
  }

  function readHands(video) {
    if (!video || !video.videoWidth) return;
    if (!hpad) { hpad = document.createElement('canvas'); hpad.width = HW; hpad.height = HH;
                 hctx = hpad.getContext('2d', { willReadFrequently: true }); }
    try { hctx.drawImage(video, 0, 0, HW, HH); } catch (e) { return; }
    var d;
    try { d = hctx.getImageData(0, 0, HW, HH).data; } catch (e) { return; }   // tainted

    var n = HW * HH;
    if (!prevY || prevY.length !== n) prevY = new Uint8Array(n);
    var mask = new Uint8Array(n), luma = new Uint8Array(n);
    /* Only the lower part: hands come up from below, and the top of the
       frame is the room and, in a viewer, sometimes a face. */
    var y0 = Math.floor(HH * 0.30);
    var moved = 0;

    for (var py = 0; py < HH; py++) {
      for (var px = 0; px < HW; px++) {
        var i = py * HW + px, j = i * 4;
        var r = d[j], g = d[j + 1], b = d[j + 2];
        var y = (r * 77 + g * 150 + b * 29) >> 8;
        luma[i] = y;
        if (py < y0) continue;
        if (!isSkin(r, g, b)) continue;
        /* Moving, or close to where a hand already is. The second half is
           what lets a hand come to a stop without vanishing - which the
           Orb game needs, and which a pure motion test would forbid. */
        var isMoving = Math.abs(y - prevY[i]) > MOVE_MIN;
        if (isMoving) moved++;
        var fx = px / HW, fy = py / HH, near = false;
        ['left', 'right'].forEach(function (k) {
          var h = hands[k];
          if (h.lost > KEEP) return;
          if (Math.abs(fx - h.x) < NEAR && Math.abs(fy - h.y) < NEAR) near = true;
        });
        if (isMoving || near) mask[i] = 1;
      }
    }
    prevY = luma;

    /* Every blob big enough to be a hand and small enough not to be a
       room, biggest first. */
    var seen = new Uint8Array(n), blobs = [];
    for (var q = y0 * HW; q < n; q++) {
      if (!mask[q] || seen[q]) continue;
      var bl = blobAt(mask, q % HW, (q / HW) | 0, seen);
      if (bl.n < MIN_PIX || bl.n > MAX_PIX) continue;
      /* A hand is roughly as wide as it is tall. A long thin streak is an
         arm across a bright window, or the edge of something. */
      if (bl.w > 0.62 || bl.h > 0.72) continue;
      blobs.push(bl);
    }
    blobs.sort(function (p2, q2) { return q2.n - p2.n; });
    blobs = blobs.slice(0, 2);

    /* WHICH BLOB IS WHICH HAND: whichever assignment moves the hands
       least. Two blobs have two possible readings and the cheaper one is
       right, which is what stops hands swapping when they cross. */
    var take = { left: null, right: null };
    if (blobs.length === 2) {
      var straight = cost(hands.left, blobs[0]) + cost(hands.right, blobs[1]);
      var swapped  = cost(hands.left, blobs[1]) + cost(hands.right, blobs[0]);
      take.left = straight <= swapped ? blobs[0] : blobs[1];
      take.right = straight <= swapped ? blobs[1] : blobs[0];
    } else if (blobs.length === 1) {
      /* One hand up. It belongs to whichever hand it is nearer, and a
         hand that has been gone a while does not get to claim it. */
      var lc = cost(hands.left, blobs[0]) + (hands.left.lost > KEEP ? 0.35 : 0);
      var rc = cost(hands.right, blobs[0]) + (hands.right.lost > KEEP ? 0.35 : 0);
      take[lc <= rc ? 'left' : 'right'] = blobs[0];
    }

    ['left', 'right'].forEach(function (k) {
      var h = hands[k], bl = take[k];
      if (!bl) {
        h.lost++;
        if (h.lost > KEEP) { h.seen = false; h.n = 0; }
        h.vx *= 0.6; h.vy *= 0.6;
        return;
      }
      h.n = bl.n;
      /* A hand that was gone lands where it is rather than sliding there
         from wherever it was last seen. */
      if (h.lost > KEEP) { h.x = bl.x; h.y = bl.y; h.vx = 0; h.vy = 0; }
      else {
        var dx = bl.x - h.x, dy = bl.y - h.y;
        /* Fast means believe it. A swing must arrive on the frame it
           happened or the sword is always behind the hand. */
        var far = Math.sqrt(dx * dx + dy * dy);
        var k2 = far > 0.05 ? 0.85 : far > 0.02 ? 0.6 : 0.32;
        h.x += dx * k2; h.y += dy * k2;
        /* The speed of the READING, not of the smoothed line. */
        h.vx = dx; h.vy = dy;
      }
      h.lost = 0;
      h.seen = true;
    });
  }

  function cost(h, bl) {
    var dx = bl.x - h.x, dy = bl.y - h.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ---- LOOKING AROUND ----

     "it should move gyroscopically."

     In a cardboard viewer the phone IS your head, so the world has to
     stay where it is when you turn. The orientation event gives yaw and
     pitch directly; everything is measured from where you were looking
     when the game started, so a game begins facing straight ahead
     wherever in the room you happen to be pointing.

     ⚠ iOS will not send a single event until permission is asked FROM A
     GESTURE, and the ask itself throws if it is called anywhere else. The
     tap that starts a game is that gesture, which is why arming lives in
     start() and not at load. Nothing breaks without it: head stays at
     zero and the world is screen-fixed, exactly as before. */
  var head = { yaw: 0, pitch: 0 }, zero = null, gyroOn = false, gyroFn = null;
  var YAW_LIMIT = 1.2, PITCH_LIMIT = 0.7;

  /* ⚠ WHICH AXIS IS "UP" DEPENDS ON HOW THE PHONE IS BEING HELD, and a
     viewer holds it on its side. In portrait the nodding axis is beta; in
     landscape it is gamma, and its SIGN depends on which way round the
     phone was turned. Reading beta whatever the phone is doing is how a
     head-tracker ends up rolling the world when you nod. */
  function pitchOf(ev) {
    var a = 0;
    try { a = (screen.orientation && screen.orientation.angle) || window.orientation || 0; }
    catch (e) { a = 0; }
    a = ((a % 360) + 360) % 360;
    if (a === 90) return -(ev.gamma || 0);
    if (a === 270) return (ev.gamma || 0);
    return (ev.beta || 0);
  }

  function onTilt(ev) {
    if (ev.alpha === null && ev.beta === null && ev.gamma === null) return;
    var yaw = (ev.alpha || 0) * Math.PI / 180;
    var pitch = pitchOf(ev) * Math.PI / 180;
    if (!zero) zero = { yaw: yaw, pitch: pitch };
    var dy = yaw - zero.yaw;
    /* Round the compass the short way, or turning past north whips the
       world through a full circle. */
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    /* alpha counts UP as you turn to the left, and yaw is positive to the
       left here, so the two agree without a sign flip. */
    head.yaw = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, dy));
    head.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch - zero.pitch));
  }

  function armGyro() {
    if (gyroOn || !window.DeviceOrientationEvent) return false;
    var go = function () {
      gyroFn = onTilt;
      window.addEventListener('deviceorientation', gyroFn, true);
      gyroOn = true;
    };
    var req = DeviceOrientationEvent.requestPermission;
    if (typeof req === 'function') {
      try { req().then(function (r) { if (r === 'granted') go(); }, function () {}); }
      catch (e) { /* not from a gesture; the game still works */ }
    } else go();
    return true;
  }

  function dropGyro() {
    if (gyroFn) window.removeEventListener('deviceorientation', gyroFn, true);
    gyroFn = null; gyroOn = false; zero = null; head.yaw = 0; head.pitch = 0;
  }
  function recentre() { zero = null; head.yaw = 0; head.pitch = 0; }

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
    /* Turn the world by the opposite of the head, which is what makes a
       cube stay where it was left when you look away from it. */
    var x = p.x, y = p.y, z = p.z;
    /* yaw is positive when you have turned LEFT, and something you have
       turned away from belongs further to the RIGHT of the view. */
    if (head.yaw) {
      var c = Math.cos(head.yaw), s2 = Math.sin(head.yaw);
      var nx = x * c + z * s2, nz = -x * s2 + z * c;
      x = nx; z = nz;
    }
    if (head.pitch) {
      var c2 = Math.cos(head.pitch), s3 = Math.sin(head.pitch);
      var ny = y * c2 - z * s3, nz2 = y * s3 + z * c2;
      y = ny; z = nz2;
    }
    if (z < 0.05) return null;
    var f = (vw * FOCAL) / z;
    return { x: vw / 2 + (x - eye) * f, y: vh / 2 - y * f, s: f };
  }
  /* A hand's screen reading, as a place in the world at blade depth. */
  function handPoint(h, vh, vw) {
    return { x: (h.x - 0.5) * SPAN, y: (0.5 - h.y) * SPAN * (vh / vw), z: HIT_Z };
  }

  /* ---- HOW A HIT FEELS ----

     "games should have nice feel to them."

     A hit that only changes a number has not happened. Every game reports
     what it did through ONE door, so a new game gets the whole feel by
     calling hit() and miss() rather than by copying any of this - and so
     the phone buzzes and the screen kicks in exactly the same way
     wherever the hit came from.

     Kept deliberately cheap: a flash is one fill, a kick is a translate,
     a pop is a number that floats and fades. No sound - a cardboard
     viewer covers the speaker, and a game that needs audio to feel good
     on a phone in a box will not get it. */
  var feel = { flash: 0, shake: 0, pops: [] };

  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }
  /* A hit: a bright flash, a small kick, a number where it happened, and
     a buzz that grows with the run so a streak can be felt. */
  function hit(text, at, weight) {
    feel.flash = Math.max(feel.flash, 0.5 * (weight || 1));
    feel.shake = Math.max(feel.shake, 3 * (weight || 1));
    if (at) feel.pops.push({ x: at.x, y: at.y, z: at.z, text: text, life: 1, up: 0 });
    while (feel.pops.length > 12) feel.pops.shift();
    buzz(Math.min(45, 12 + (weight || 1) * 8));
  }
  /* A miss: a longer, duller kick and no flash. Losing a streak should
     read differently from landing one, without a word on the screen. */
  function miss() {
    feel.shake = Math.max(feel.shake, 7);
    buzz([14, 40, 14]);
  }
  function feelStep(dt) {
    feel.flash = Math.max(0, feel.flash - dt * 3.2);
    feel.shake = Math.max(0, feel.shake - dt * 34);
    for (var i = feel.pops.length - 1; i >= 0; i--) {
      var p = feel.pops[i];
      p.life -= dt * 1.5; p.up += dt * 0.55;
      if (p.life <= 0) feel.pops.splice(i, 1);
    }
  }
  function feelDraw(ctx, eye, vw, vh) {
    feel.pops.forEach(function (p) {
      var q = project({ x: p.x, y: p.y + p.up, z: p.z }, eye, vw, vh);
      if (!q) return;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = '#b8ff6a';
      ctx.font = '700 ' + Math.max(11, Math.min(26, 15 / p.z * 2)) + 'px ui-monospace,Menlo,monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.text, q.x, q.y);
      ctx.restore();
    });
  }

  /* ---- the games ---- */

  var GAMES = {
    slice: {
      title: 'Cube Slice',
      how: 'Cubes come at you. Swing a hand through one to cut it. Two hands, two swords.',
      make: function () { return sliceGame(); }
    },
    /* The opposite skill on the same hands, deliberately: one game rewards
       swinging and the other punishes it, so the tracker is proven to read
       movement rather than just presence. */
    orbs: {
      title: 'Orb Hold',
      how: 'Orbs drift in. Hold a hand still on one to charge it until it pops. Swinging scatters them.',
      make: function () { return orbGame(); }
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
        /* It gets harder. A game at one speed for ever is a demo; the
           ramp is what makes the thirtieth cube worth cutting. Both ends
           are capped so it never becomes unplayable. */
        var ramp = Math.min(1, t / 90);
        SPEED = 2.2 + ramp * 1.5;
        var gap = EVERY * (1 - ramp * 0.45);
        if (t > next) { next = t + gap * (0.7 + Math.random() * 0.6); spawn(); }

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
              var got = 10 + combo * 2;
              score += got;
              combo++;
              if (combo > best) best = combo;
              hit('+' + got, { x: c.x, y: c.y, z: c.z }, Math.min(3, 1 + combo / 6));
              var ang = Math.atan2(h.vy, h.vx);
              bits.push({ x: c.x, y: c.y, z: c.z, size: c.size, life: 1,
                          vx: Math.cos(ang) * 0.8, vy: -Math.sin(ang) * 0.8, spin: c.spin });
              bits.push({ x: c.x, y: c.y, z: c.z, size: c.size, life: 1,
                          vx: -Math.cos(ang) * 0.8, vy: Math.sin(ang) * 0.8, spin: -c.spin });
              cubes.splice(i, 1);
            });
          }
          if (!c.cut && c.z < 0.2) { cubes.splice(i, 1); missed++; combo = 0; miss(); }
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

  /* ---- ORB HOLD ----

     A steadiness game. An orb charges only while a hand is ON it and
     STILL; moving fast scatters the charge instead of adding to it. */
  function orbGame() {
    var orbs = [], t = 0, next = 0, score = 0, combo = 0, best = 0, missed = 0;
    var SPEED = 1.15, EVERY = 1.5, REACH = 0.42, STILL = 0.009, FULL = 0.9;

    function spawn() {
      orbs.push({
        x: (Math.random() - 0.5) * SPAN * 0.7,
        y: (Math.random() * 0.5 - 0.15) * SPAN * 0.4,
        z: 8 + Math.random() * 2,
        size: 0.2, charge: 0, spin: 0, cut: false
      });
    }

    return {
      score: function () { return { score: score, combo: combo, best: best, missed: missed,
                                    live: orbs.length }; },
      step: function (dt) {
        t += dt;
        if (t > next) { next = t + EVERY * (0.7 + Math.random() * 0.6); spawn(); }
        var hs = handState();
        for (var i = orbs.length - 1; i >= 0; i--) {
          var o = orbs[i];
          o.z -= SPEED * dt;
          var held = false, wild = false;
          ['left', 'right'].forEach(function (k) {
            var h = hs[k];
            if (!h.seen) return;
            var p = handPoint(h, 1, 1);
            if (Math.abs(p.x - o.x) > o.size + REACH) return;
            if (Math.abs(p.y - o.y) > o.size + REACH) return;
            if (Math.sqrt(h.vx * h.vx + h.vy * h.vy) > STILL) wild = true;
            else held = true;
          });
          /* A wild hand undoes the work, so waving at everything is worse
             than doing nothing. */
          if (wild) o.charge = Math.max(0, o.charge - dt * 1.4);
          else if (held) o.charge += dt;
          if (o.charge >= FULL) {
            var got = 15 + combo * 3;
            score += got; combo++;
            if (combo > best) best = combo;
            hit('+' + got, { x: o.x, y: o.y, z: o.z }, Math.min(3, 1 + combo / 5));
            orbs.splice(i, 1);
            continue;
          }
          if (o.z < 0.2) { orbs.splice(i, 1); missed++; combo = 0; miss(); }
        }
      },
      draw: function (ctx, eye, vw, vh) {
        ctx.strokeStyle = 'rgba(79,227,255,.14)';
        ctx.lineWidth = 1;
        for (var g = 1; g <= 9; g++) {
          var a = project({ x: -SPAN, y: -0.62, z: g }, eye, vw, vh);
          var b = project({ x: SPAN, y: -0.62, z: g }, eye, vw, vh);
          if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        }
        orbs.slice().sort(function (p, q) { return q.z - p.z; }).forEach(function (o) {
          var f = project({ x: o.x, y: o.y, z: o.z }, eye, vw, vh);
          if (!f) return;
          var r = o.size * f.s;
          ctx.save();
          ctx.strokeStyle = '#4fe3ff'; ctx.lineWidth = Math.max(1.5, 3 / o.z);
          ctx.globalAlpha = 0.35;
          ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, Math.PI * 2); ctx.stroke();
          /* The charge is an arc round the orb, so how far along it is can
             be read without a number. */
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#b8ff6a'; ctx.lineWidth = Math.max(2.5, 5 / o.z);
          ctx.beginPath();
          ctx.arc(f.x, f.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (o.charge / FULL));
          ctx.stroke();
          ctx.restore();
        });
        /* One dot a hand: this game is about where a hand IS, not what it
           is swinging. */
        var hs = handState();
        ['left', 'right'].forEach(function (k) {
          var h = hs[k];
          if (!h.seen) return;
          var p = project(handPoint(h, vh, vw), eye, vw, vh);
          if (!p) return;
          ctx.fillStyle = k === 'left' ? 'rgba(79,227,255,.85)' : 'rgba(255,122,212,.85)';
          ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill();
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
    /* Armed HERE because the tap that started the game is the gesture iOS
       requires before it will send a single orientation event. */
    armGyro();
    recentre();
    feel.flash = 0; feel.shake = 0; feel.pops = [];
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
    dropGyro();
    feel.flash = 0; feel.shake = 0; feel.pops = [];
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
    feelStep(dt);
    draw();
  }

  function draw() {
    if (!ctx || !cv) return;
    var w = cv.clientWidth, h = cv.clientHeight;
    var vw = w / 2;
    ctx.fillStyle = '#04070b';
    ctx.fillRect(0, 0, w, h);
    /* Two eyes, two viewports, one world. */
    /* The kick. Both eyes move together or it reads as a broken screen
       rather than as a hit. */
    var kx = feel.shake ? (Math.random() - 0.5) * feel.shake : 0;
    var ky = feel.shake ? (Math.random() - 0.5) * feel.shake : 0;
    [[-EYE, 0], [EYE, vw]].forEach(function (pair) {
      ctx.save();
      ctx.beginPath(); ctx.rect(pair[1], 0, vw, h); ctx.clip();
      ctx.translate(pair[1] + kx, ky);
      game.draw(ctx, pair[0], vw, h);
      feelDraw(ctx, pair[0], vw, h);
      if (feel.flash > 0) {
        ctx.globalAlpha = Math.min(0.4, feel.flash * 0.4);
        ctx.fillStyle = '#b8ff6a';
        ctx.fillRect(-kx, -ky, vw, h);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    });
    /* The score sits between the eyes, where both can read it. */
    var s = game.score();
    ctx.save();
    ctx.textAlign = 'center';
    /* A streak is the thing worth looking at, so it is the thing that
       grows. The score is steady underneath it. */
    ctx.fillStyle = s.combo > 2 ? '#b8ff6a' : 'rgba(230,240,250,.9)';
    ctx.font = '700 ' + Math.min(26, 15 + s.combo) + 'px ui-monospace,Menlo,monospace';
    ctx.fillText('x' + s.combo, w / 2, 26);
    ctx.fillStyle = 'rgba(230,240,250,.75)';
    ctx.font = '600 12px ui-monospace,Menlo,monospace';
    ctx.fillText(s.score, w / 2, 44);
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
           _project: project, _handPoint: handPoint, _draw: draw,
           _head: function () { return { yaw: head.yaw, pitch: head.pitch }; },
           _setHead: function (y, p2) { head.yaw = y; head.pitch = p2; },
           _tilt: onTilt, _recentre: recentre, _feelStep: feelStep,
           _feel: function () { return { flash: feel.flash, shake: feel.shake,
                                         pops: feel.pops.length }; } };
})();
