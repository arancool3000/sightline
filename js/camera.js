/* Sightline - camera plumbing: stream, orientation, and cropping frames. */
'use strict';

var CAM = (function () {

  var video = null, stream = null, facing = 'environment';
  var work = document.createElement('canvas');     // scratch for crops
  var wctx = work.getContext('2d', { willReadFrequently: true });

  function attach(v) {
    video = v;
    /* NOTHING IN THIS APP EVER WANTS THE CAMERA PAUSED.

       "camera freezes after saving someone's name... i have to press the
        camera switch button twice and camera is back."

       window.prompt() is a native modal, and iOS pauses a playing <video>
       while one is up. Nothing played it again afterwards, so the last
       painted frame sat there looking like a crash - and flipping twice
       fixed it only because each flip re-acquires the stream.

       Rather than hunt every dialog that might do this, the rule is the
       simple one: this element is a live camera, so if anything pauses it
       it goes straight back to playing. */
    video.addEventListener('pause', function () {
      if (stream) wake();
    });
    /* Coming back from the app switcher, or from a modal that suspended
       the whole page, lands here rather than on 'pause'. */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) wake();
    });
  }

  /* Play it if it is not playing. Safe to call at any time. */
  function wake() {
    if (!video || !stream) return false;
    if (!video.paused && video.readyState >= 2) return false;
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
    return true;
  }

  function stop() {
    if (recorder) stopRec();
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  /* ---- ZOOM ----

     Two kinds, and the caller should not have to know which it got. A
     phone camera that reports a zoom capability is zoomed for real, in the
     lens; anything else is scaled in the page, which is a crop of the same
     pixels but is what "zoom in" means to the person asking.

     "if x is too big it goes to maximum available zoom" - so nothing here
     ever refuses a number. It clamps and says where it landed. */
  var zoomAt = 1, digital = 1;

  function track() {
    if (!stream) return null;
    var t = stream.getVideoTracks()[0];
    return t || null;
  }
  function zoomRange() {
    var t = track();
    var c = t && t.getCapabilities ? t.getCapabilities() : null;
    if (c && c.zoom && c.zoom.max > c.zoom.min) {
      return { min: c.zoom.min, max: c.zoom.max, real: true, step: c.zoom.step || 0.1 };
    }
    /* No lens zoom: scale the picture instead, up to 4x, past which a
       720-line frame is mush and pretending otherwise helps nobody. */
    return { min: 1, max: 4, real: false, step: 0.1 };
  }
  function zoom() { return zoomAt; }

  /* Set an absolute factor. Answers what it actually reached. */
  function setZoom(v) {
    var r = zoomRange();
    var want = Math.max(r.min, Math.min(r.max, Number(v) || r.min));
    zoomAt = want;
    if (r.real) {
      var t = track();
      try { t.applyConstraints({ advanced: [{ zoom: want }] }); } catch (e) { /* refused mid-frame */ }
      digital = 1;
    } else {
      digital = want;
      if (video) {
        video.style.transform = (facing === 'user' ? 'scaleX(-1) ' : '') +
                                (want > 1.001 ? 'scale(' + want.toFixed(3) + ')' : '');
      }
    }
    return { at: want, max: r.max, min: r.min, capped: want !== (Number(v) || r.min), real: r.real };
  }
  /* Relative, which is how anybody says it out loud: "zoom in by two". */
  function zoomBy(mult) {
    var m = Number(mult);
    if (!isFinite(m) || m <= 0) m = 2;
    return setZoom(zoomAt * m);
  }

  /* ---- A STILL ----

     Full frame at the sensor's own size, drawn once. Answers a data URL so
     the caller can show it, save it, or hand it to something else. */
  function photo() {
    if (!live()) return null;
    var w = video.videoWidth, h = video.videoHeight;
    /* Digital zoom is a crop, so a photograph taken while zoomed is the
       crop the person can see, not the whole sensor behind it. */
    var sw = w / digital, sh = h / digital;
    var sx = (w - sw) / 2, sy = (h - sh) / 2;
    work.width = Math.round(sw); work.height = Math.round(sh);
    if (facing === 'user') { wctx.save(); wctx.translate(work.width, 0); wctx.scale(-1, 1); }
    wctx.drawImage(video, sx, sy, sw, sh, 0, 0, work.width, work.height);
    if (facing === 'user') wctx.restore();
    return work.toDataURL('image/jpeg', 0.92);
  }

  /* ---- VIDEO ----

     MediaRecorder over the same track, so nothing is re-encoded and
     nothing else has to stop. The container is whatever the browser will
     actually give: Safari wants mp4, everything else takes webm, and
     asking for one it does not have records nothing at all. */
  var recorder = null, chunks = [], recStart = 0;

  function recType() {
    var want = ['video/mp4;codecs=avc1', 'video/mp4',
                'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < want.length; i++) if (MediaRecorder.isTypeSupported(want[i])) return want[i];
    return '';
  }
  function recording() { return !!recorder; }
  function recMs() { return recorder ? (Date.now() - recStart) : 0; }

  function startRec() {
    if (recorder || !stream || !window.MediaRecorder) return false;
    var type = recType();
    try { recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream); }
    catch (e) { recorder = null; return false; }
    chunks = []; recStart = Date.now();
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(1000);        // a slice a second, so a crash loses one second
    return true;
  }
  /* Answers a blob URL and how long it ran, or null if nothing was going. */
  function stopRec() {
    if (!recorder) return Promise.resolve(null);
    var r = recorder, ms = Date.now() - recStart;
    recorder = null;
    return new Promise(function (res) {
      r.onstop = function () {
        var blob = new Blob(chunks, { type: r.mimeType || 'video/webm' });
        chunks = [];
        res({ url: URL.createObjectURL(blob), ms: ms, type: blob.type, bytes: blob.size });
      };
      try { r.stop(); } catch (e) { res(null); }
    });
  }

  function start(which) {
    facing = which || facing;
    stop();
    var want = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      }
    };
    return navigator.mediaDevices.getUserMedia(want)
      .catch(function () {
        /* Some devices reject an exact/ideal facingMode. Take any camera
           rather than failing to a black screen. */
        return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        video.classList.toggle('mirror', facing === 'user');
        /* A new stream starts at 1: a lens zoom does not survive it, and a
           digital one left behind would scale the wrong picture. */
        zoomAt = 1; digital = 1; video.style.transform = '';
        return video.play().catch(function () { /* autoplay policies */ });
      })
      .then(function () { return ready(); });
  }

  /* Resolve once the video actually has pixel dimensions - metadata can
     arrive after play() resolves, and every box maths below needs them. */
  function ready() {
    if (video.videoWidth) return Promise.resolve();
    return new Promise(function (res) {
      var done = false;
      function go() { if (!done) { done = true; res(); } }
      video.addEventListener('loadedmetadata', go, { once: true });
      setTimeout(go, 2500);
    });
  }

  function flip() { return start(facing === 'environment' ? 'user' : 'environment'); }
  function current() { return facing; }
  function size() { return { w: video ? video.videoWidth : 0, h: video ? video.videoHeight : 0 }; }
  function live() { return !!(stream && video && video.videoWidth); }

  /* object-fit:cover maths - the video is cropped to fill the element, so a
     point on screen is not a point in the frame without this. */
  function coverMap() {
    var vw = video.videoWidth, vh = video.videoHeight;
    var ew = video.clientWidth, eh = video.clientHeight;
    if (!vw || !vh || !ew || !eh) return { scale: 1, dx: 0, dy: 0, vw: vw, vh: vh, ew: ew, eh: eh };
    var scale = Math.max(ew / vw, eh / vh);
    return {
      scale: scale, dx: (ew - vw * scale) / 2, dy: (eh - vh * scale) / 2, vw: vw, vh: vh, ew: ew, eh: eh };
  }

  /* Frame box [x,y,w,h] -> on-screen CSS box. */
  function toScreen(box) {
    var m = coverMap();
    var x = box[0] * m.scale + m.dx;
    var y = box[1] * m.scale + m.dy;
    var w = box[2] * m.scale, h = box[3] * m.scale;
    if (facing === 'user') x = m.ew - x - w;   // the preview is mirrored
    return [x, y, w, h];
  }

  /* Crop a frame-space box to a JPEG data URL, padded a little for context
     and capped in size so one lookup stays small on a phone connection. */
  function crop(box, maxPx, pad, quality) {
    if (!live()) return null;
    maxPx = maxPx || 512;
    pad = pad == null ? 0.12 : pad;

    var vw = video.videoWidth, vh = video.videoHeight;
    var px = box[2] * pad, py = box[3] * pad;
    var x = U.clamp(box[0] - px, 0, vw), y = U.clamp(box[1] - py, 0, vh);
    var w = U.clamp(box[2] + px * 2, 1, vw - x), h = U.clamp(box[3] + py * 2, 1, vh - y);

    var scale = Math.min(1, maxPx / Math.max(w, h));
    work.width  = Math.max(1, Math.round(w * scale));
    work.height = Math.max(1, Math.round(h * scale));
    wctx.drawImage(video, x, y, w, h, 0, 0, work.width, work.height);
    try { return work.toDataURL('image/jpeg', quality || 0.72); }
    catch (e) { return null; }   // tainted canvas should not happen, but never throw into the loop
  }

  /* A picture of what the camera can see right now, as a data URL, for
     anything that needs to ASK about the scene rather than measure it. */
  var shotPad = null;
  function frame(maxSide) {
    if (!video || !video.videoWidth) return null;
    var side = maxSide || 768;
    var f = Math.min(1, side / Math.max(video.videoWidth, video.videoHeight));
    var w = Math.round(video.videoWidth * f), h = Math.round(video.videoHeight * f);
    if (!shotPad) shotPad = document.createElement('canvas');
    if (shotPad.width !== w || shotPad.height !== h) { shotPad.width = w; shotPad.height = h; }
    try {
      shotPad.getContext('2d').drawImage(video, 0, 0, w, h);
      return shotPad.toDataURL('image/jpeg', 0.72);
    } catch (e) { return null; }
  }

  return { attach: attach, start: start, stop: stop, flip: flip, current: current, wake: wake,
           zoom: zoom, setZoom: setZoom, zoomBy: zoomBy, zoomRange: zoomRange,
           photo: photo, startRec: startRec, stopRec: stopRec, recording: recording, recMs: recMs,
           canRecord: function () { return !!(window.MediaRecorder && recType()); },
           size: size, live: live, crop: crop, toScreen: toScreen, coverMap: coverMap,
           frame: frame };
})();
