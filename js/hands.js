/* hands.js - real hand tracking, on the device, with no key and no limit.

   "hand tracking is very bad" ... "hand tracking is very very bad."

   Twice. The answer is not a third go at the colour heuristic: a skin
   mask cannot tell a hand from a wooden door, a face, or a patch of
   sunlight, and every fix for one of those makes it worse at another. It
   was the wrong instrument, and tuning it again would have been the
   third round of the same mistake.

   So this is the real thing: MediaPipe's palm detector and hand-landmark
   models, the same pair that runs in Google Meet, as .tflite files
   VENDORED INTO THE REPO. Four megabytes, fetched once, cached by the
   service worker, and then offline for ever - no key, no account, no
   per-call limit, which is the standing rule for everything in this app.
   The tflite runtime was already here for the species models.

   HOW IT RUNS, AND WHY IT IS NOT EXPENSIVE. MediaPipe's own arrangement:
   the DETECTOR is the costly half and it only runs when a hand is not
   already being followed. Once found, the small landmark model tracks it
   from the previous frame's box, and the detector sleeps until tracking
   is lost. Steady state is one 224x224 model per hand.

   WHAT A CALLER GETS: 21 landmarks per hand, the fingertip and the palm
   named, and a handedness. Everything is in fractions of the frame, so
   nothing downstream needs to know the camera's size.

   ⚠ AND IT FALLS BACK. A device where the models will not load still
   gets the old skin tracker rather than a game that cannot be played -
   VR asks `good()` and uses whichever is answering. */

var HANDS = (function () {
  'use strict';

  var PALM = 'vendor/models/hands/palm_detection_lite.tflite';
  var MARK = 'vendor/models/hands/hand_landmark_lite.tflite';
  var PALM_IN = 192, MARK_IN = 224;

  var palm = null, mark = null, loading = null, err = '', ready = false;

  /* ---- the runtime, shared with the species models ---- */
  function runtime() {
    if (window.tflite && tflite.loadTFLiteModel) return Promise.resolve(true);
    return new Promise(function (res) {
      var sc = document.createElement('script');
      sc.src = 'vendor/tf-tflite.min.js';
      sc.onload = function () { res(!!(window.tflite && tflite.loadTFLiteModel)); };
      sc.onerror = function () { err = 'the tflite runtime could not be fetched'; res(false); };
      document.head.appendChild(sc);
      setTimeout(function () { res(!!(window.tflite && tflite.loadTFLiteModel)); }, 20000);
    });
  }

  function load() {
    if (loading) return loading;
    loading = runtime().then(function (ok) {
      if (!ok) throw new Error(err || 'no tflite runtime');
      try { tflite.setWasmPath('vendor/'); } catch (e) {}
      return Promise.all([tflite.loadTFLiteModel(PALM), tflite.loadTFLiteModel(MARK)]);
    }).then(function (m) {
      palm = m[0]; mark = m[1]; ready = true;
      return true;
    }).catch(function (e) {
      err = String(e && e.message || e).slice(0, 110);
      ready = false;
      return false;
    });
    return loading;
  }

  function good() { return ready; }
  function why() { return err; }

  /* ---- ANCHORS ----

     The detector answers 2016 boxes as offsets from a fixed grid, so the
     grid has to be rebuilt exactly as it was at training time or every
     box lands in the wrong place. palm_detection_lite: four layers over
     192 pixels at strides 8, 16, 16, 16, two anchors a cell, which is
     24*24*2 + three of 12*12*2 = 2016. The count is the check: if this
     does not come to 2016 the scheme is wrong and nothing below means
     anything. */
  var anchors = null;
  function buildAnchors() {
    var out = [], strides = [8, 16, 16, 16];
    for (var s = 0; s < strides.length; s++) {
      var g = Math.ceil(PALM_IN / strides[s]);
      for (var y = 0; y < g; y++) {
        for (var x = 0; x < g; x++) {
          for (var a = 0; a < 2; a++) out.push([(x + 0.5) / g, (y + 0.5) / g]);
        }
      }
    }
    return out;
  }

  /* ---- reading the detector ---- */
  var MIN_SCORE = 0.55, NMS = 0.3;

  function decode(reg, scores) {
    if (!anchors) anchors = buildAnchors();
    var out = [];
    for (var i = 0; i < anchors.length; i++) {
      var s = 1 / (1 + Math.exp(-Math.max(-100, Math.min(100, scores[i]))));
      if (s < MIN_SCORE) continue;
      var o = i * 18, an = anchors[i];
      /* ⚠ The order is REVERSED in this graph: x, y, w, h - not the
         y, x, h, w a reader of the tensor would assume. */
      var cx = reg[o] / PALM_IN + an[0];
      var cy = reg[o + 1] / PALM_IN + an[1];
      var w  = reg[o + 2] / PALM_IN;
      var h  = reg[o + 3] / PALM_IN;
      /* Two of the seven keypoints are all that is wanted: the wrist and
         the knuckle of the middle finger. The line between them is which
         way the hand is pointing. */
      var wristX = reg[o + 4] / PALM_IN + an[0], wristY = reg[o + 5] / PALM_IN + an[1];
      var midX   = reg[o + 8] / PALM_IN + an[0], midY   = reg[o + 9] / PALM_IN + an[1];
      out.push({ score: s, cx: cx, cy: cy, w: w, h: h,
                 wrist: [wristX, wristY], mid: [midX, midY] });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return nms(out);
  }

  function overlap(a, b) {
    var ax0 = a.cx - a.w / 2, ay0 = a.cy - a.h / 2, ax1 = ax0 + a.w, ay1 = ay0 + a.h;
    var bx0 = b.cx - b.w / 2, by0 = b.cy - b.h / 2, bx1 = bx0 + b.w, by1 = by0 + b.h;
    var iw = Math.min(ax1, bx1) - Math.max(ax0, bx0);
    var ih = Math.min(ay1, by1) - Math.max(ay0, by0);
    if (iw <= 0 || ih <= 0) return 0;
    var inter = iw * ih;
    return inter / (a.w * a.h + b.w * b.h - inter);
  }
  function nms(list) {
    var keep = [];
    for (var i = 0; i < list.length && keep.length < 4; i++) {
      var clash = false;
      for (var j = 0; j < keep.length; j++) if (overlap(list[i], keep[j]) > NMS) { clash = true; break; }
      if (!clash) keep.push(list[i]);
    }
    return keep;
  }

  /* ---- THE CROP THE LANDMARK MODEL WANTS ----

     Not the palm box: a square about two and a half times its size,
     shifted along the hand and TURNED so the fingers point up. The model
     was trained on upright hands, and handing it a sideways one is most
     of the difference between landmarks that sit on the fingers and
     landmarks that sit near them. The canvas does the turning, and the
     landmarks are turned back afterwards. */
  var SCALE = 2.6, SHIFT = -0.5;

  /* MediaPipe's RectTransformation, done as it is written rather than as
     it looked: the shift is measured in the ORIGINAL box, not the scaled
     one, and it turns with the rect. The first cut used the scaled side
     and the opposite angle, which is how the region ended up off the
     picture. */
  function rect(cx, cy, size, ang) {
    var sx = size * 0 * Math.cos(ang) - size * SHIFT * Math.sin(ang);
    var sy = size * 0 * Math.sin(ang) + size * SHIFT * Math.cos(ang);
    return { cx: cx + sx, cy: cy + sy, side: size * SCALE, ang: ang };
  }
  /* The angle that stands the hand up. MediaPipe: the target is 90
     degrees, measured from the wrist to the middle knuckle, with y
     counted downwards. */
  function upright(from, to) {
    var a = Math.PI / 2 - Math.atan2(-(to[1] - from[1]), to[0] - from[0]);
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function roiOf(d) {
    return rect(d.cx, d.cy, Math.max(d.w, d.h), upright(d.wrist, d.mid));
  }
  /* The box to re-crop from on the NEXT frame, derived from the landmarks
     we just got - which is what lets the detector go back to sleep. */
  function roiFromMarks(pts) {
    var minx = 9, miny = 9, maxx = -9, maxy = -9;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i][0] < minx) minx = pts[i][0];
      if (pts[i][0] > maxx) maxx = pts[i][0];
      if (pts[i][1] < miny) miny = pts[i][1];
      if (pts[i][1] > maxy) maxy = pts[i][1];
    }
    var size = Math.max(maxx - minx, maxy - miny);
    return { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2,
             side: size * 1.9, ang: upright(pts[0], pts[9]) };
  }

  /* ---- pads ---- */
  var pPad = null, pCtx = null, mPad = null, mCtx = null;
  function pads() {
    if (!pPad) {
      pPad = document.createElement('canvas'); pPad.width = pPad.height = PALM_IN;
      pCtx = pPad.getContext('2d', { willReadFrequently: true });
      mPad = document.createElement('canvas'); mPad.width = mPad.height = MARK_IN;
      mCtx = mPad.getContext('2d', { willReadFrequently: true });
    }
  }

  /* Pixels to a tensor the way both models were trained: RGB, 0 to 1. */
  function toTensor(ctx, size) {
    var d = ctx.getImageData(0, 0, size, size).data;
    var n = size * size, f = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      f[i * 3] = d[i * 4] / 255;
      f[i * 3 + 1] = d[i * 4 + 1] / 255;
      f[i * 3 + 2] = d[i * 4 + 2] / 255;
    }
    return tf.tensor4d(f, [1, size, size, 3]);
  }

  function readOut(res, i) {
    /* A tflite model answers an array on some builds and a named map on
       others, and reading the wrong shape is a silent zero. */
    if (Array.isArray(res)) return res[i];
    if (res && res.dataSync) return i === 0 ? res : null;
    if (res && typeof res === 'object') {
      var keys = Object.keys(res).sort();
      return res[keys[i]];
    }
    return null;
  }

  /* ---- finding hands ----

     ⚠ EVERYTHING HERE IS IN "SQUARE SPACE": fractions of the LETTERBOXED
     square, not of the frame. The first cut converted detections back to
     frame fractions and then did the crop geometry in those, which mixes
     two different units per axis on a 16:9 picture - the region came out
     centred at y = 1.26, off the bottom of the world, and the landmark
     model was handed a black square every time. One space, converted to
     pixels once, at the end. */
  function squareOf(video) {
    var vw = video.videoWidth, vh = video.videoHeight, S = Math.max(vw, vh);
    return { S: S, ox: (S - vw) / 2, oy: (S - vh) / 2, vw: vw, vh: vh };
  }
  function toPx(sq, u, v) { return [u * sq.S - sq.ox, v * sq.S - sq.oy]; }

  function detect(video) {
    pads();
    var sq = squareOf(video);
    pCtx.fillStyle = '#000';
    pCtx.fillRect(0, 0, PALM_IN, PALM_IN);
    pCtx.drawImage(video, sq.ox / sq.S * PALM_IN, sq.oy / sq.S * PALM_IN,
                   sq.vw / sq.S * PALM_IN, sq.vh / sq.S * PALM_IN);
    var t = toTensor(pCtx, PALM_IN), res;
    try { res = palm.predict(t); } finally { t.dispose(); }
    var reg = readOut(res, 0), sc = readOut(res, 1);
    if (!reg || !sc) return [];
    var r = reg.dataSync(), s2 = sc.dataSync();
    try { reg.dispose(); sc.dispose(); } catch (e) {}
    return decode(r, s2);
  }

  var MIN_PRESENT = 0.5;

  function landmarks(video, roi) {
    pads();
    var sq = squareOf(video);
    var c = toPx(sq, roi.cx, roi.cy);
    var half = roi.side * sq.S / 2;
    if (!(half > 2)) return null;
    mCtx.save();
    mCtx.fillStyle = '#000';
    mCtx.fillRect(0, 0, MARK_IN, MARK_IN);
    mCtx.translate(MARK_IN / 2, MARK_IN / 2);
    mCtx.scale(MARK_IN / (half * 2), MARK_IN / (half * 2));
    mCtx.rotate(-roi.ang);
    mCtx.translate(-c[0], -c[1]);
    try { mCtx.drawImage(video, 0, 0, sq.vw, sq.vh); } catch (e) { mCtx.restore(); return null; }
    mCtx.restore();

    var t = toTensor(mCtx, MARK_IN), res;
    try { res = mark.predict(t); } finally { t.dispose(); }
    var lm = readOut(res, 0), flag = readOut(res, 1), hand = readOut(res, 2);
    if (!lm || !flag) return null;
    var a = lm.dataSync(), present = flag.dataSync()[0];
    var handed = hand ? hand.dataSync()[0] : 0.5;
    try { lm.dispose(); flag.dispose(); if (hand) hand.dispose(); } catch (e) {}
    if (present < MIN_PRESENT) return null;

    /* Out of the crop, back through the turn, into square space. */
    var cos = Math.cos(roi.ang), sin = Math.sin(roi.ang);
    var pts = [];
    for (var i = 0; i < 21; i++) {
      var lx = (a[i * 3] / MARK_IN - 0.5) * half * 2;
      var ly = (a[i * 3 + 1] / MARK_IN - 0.5) * half * 2;
      var rx = lx * cos - ly * sin;
      var ry = lx * sin + ly * cos;
      pts.push([(c[0] + rx + sq.ox) / sq.S, (c[1] + ry + sq.oy) / sq.S]);
    }
    return { pts: pts, present: present, handed: handed, sq: sq };
  }

  /* ---- WHAT THE CALLER SEES ----

     Two slots, kept between frames. The detector only runs when a slot is
     empty, which is what keeps this affordable. */
  var slots = [null, null];
  var DETECT_EVERY = 500;         // ms between detector passes when a slot is empty
  var lastDetect = 0, busy = false;

  function blank() {
    return { seen: false, x: 0.5, y: 0.5, vx: 0, vy: 0, pts: null, side: 'right', lost: 99 };
  }
  var out = { left: blank(), right: blank() };

  /* One step. Synchronous on purpose: the caller is a game loop and an
     answer that arrives two frames late is a sword that lags. */
  function step(video) {
    if (!ready || !video || !video.videoWidth || busy) return;
    busy = true;
    try { work(video); } catch (e) { err = String(e && e.message || e).slice(0, 110); }
    busy = false;
  }

  function work(video) {
    var now = performance.now();
    var empty = slots[0] === null || slots[1] === null;
    if (empty && now - lastDetect > DETECT_EVERY) {
      lastDetect = now;
      var found = detect(video);
      for (var i = 0; i < found.length && i < 2; i++) {
        var roi = roiOf(found[i]);
        /* Do not take a hand we are already following. */
        var dup = false;
        for (var k = 0; k < 2; k++) {
          var s = slots[k];
          if (s && Math.abs(s.roi.cx - roi.cx) < 0.15 && Math.abs(s.roi.cy - roi.cy) < 0.15) dup = true;
        }
        if (dup) continue;
        var free = slots[0] === null ? 0 : (slots[1] === null ? 1 : -1);
        if (free < 0) break;
        slots[free] = { roi: roi, pts: null, handed: 0.5, miss: 0 };
      }
    }

    for (var j = 0; j < 2; j++) {
      var sl = slots[j];
      if (!sl) continue;
      var r = landmarks(video, sl.roi);
      if (!r) {
        sl.miss++;
        /* Three empty frames and the slot is given back to the detector.
           One is a blink; three is a hand that has gone. */
        if (sl.miss > 3) slots[j] = null;
        continue;
      }
      sl.miss = 0;
      sl.pts = r.pts;
      sl.sq = r.sq;
      sl.handed = r.handed;
      sl.roi = roiFromMarks(r.pts);
    }

    publish();
  }

  /* WHICH HAND IS WHICH. The model's own handedness is the answer when
     it is confident; where it is not, the one further left in the
     picture is the left one, which is true of a person facing away from
     a rear camera - and in a viewer that is always the case. */
  function publish() {
    var live = [];
    for (var i = 0; i < 2; i++) if (slots[i] && slots[i].pts) live.push(slots[i]);

    var got = { left: null, right: null };
    if (live.length === 2) {
      var a = live[0], b = live[1];
      var aLeft = palmOf(a.pts)[0] < palmOf(b.pts)[0];
      got.left = aLeft ? a : b;
      got.right = aLeft ? b : a;
    } else if (live.length === 1) {
      var one = live[0];
      var side = one.handed > 0.6 ? 'right' : one.handed < 0.4 ? 'left'
               : (palmOf(one.pts)[0] < 0.5 ? 'left' : 'right');
      got[side] = one;
    }

    ['left', 'right'].forEach(function (k) {
      var h = out[k], s = got[k];
      if (!s) { h.lost++; if (h.lost > 2) { h.seen = false; h.pts = null; } h.vx *= 0.6; h.vy *= 0.6; return; }
      /* Square space is the tracker's business; a caller wants fractions
         of the picture it can see. Converted once, here. */
      var pts = s.sq ? s.pts.map(function (q) {
        return [(q[0] * s.sq.S - s.sq.ox) / s.sq.vw, (q[1] * s.sq.S - s.sq.oy) / s.sq.vh];
      }) : s.pts;
      s.shown = pts;
      var p = palmOf(pts);
      if (h.lost > 2) { h.x = p[0]; h.y = p[1]; h.vx = 0; h.vy = 0; }
      else { h.vx = p[0] - h.x; h.vy = p[1] - h.y; h.x = p[0]; h.y = p[1]; }
      h.lost = 0; h.seen = true; h.pts = pts; h.side = k;
    });
  }

  /* The middle of the palm, which is what a blade is held in - not the
     wrist, and not a fingertip. Landmarks 0, 5, 9, 13 and 17 are the
     wrist and the four knuckles. */
  var PALM_PTS = [0, 5, 9, 13, 17];
  function palmOf(pts) {
    var x = 0, y = 0;
    for (var i = 0; i < PALM_PTS.length; i++) { x += pts[PALM_PTS[i]][0]; y += pts[PALM_PTS[i]][1]; }
    return [x / PALM_PTS.length, y / PALM_PTS.length];
  }
  function tipOf(pts) { return pts ? pts[8] : null; }     // the index fingertip

  function state() {
    var one = function (h) {
      return { x: h.x, y: h.y, vx: h.vx, vy: h.vy, seen: h.seen,
               pts: h.pts, tip: tipOf(h.pts), n: h.pts ? 21 : 0 };
    };
    return { left: one(out.left), right: one(out.right) };
  }

  function forget() {
    slots = [null, null];
    out.left = blank(); out.right = blank();
    lastDetect = 0;
  }

  return { load: load, good: good, why: why, step: step, state: state, forget: forget,
           _decode: decode, _anchors: function () { return (anchors || (anchors = buildAnchors())).length; },
           _roiOf: roiOf, _palmOf: palmOf, _detect: detect, _landmarks: landmarks };
})();
