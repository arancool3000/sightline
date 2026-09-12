/* Sightline - camera plumbing: stream, orientation, and cropping frames. */
'use strict';

var CAM = (function () {

  var video = null, stream = null, facing = 'environment';
  var work = document.createElement('canvas');     // scratch for crops
  var wctx = work.getContext('2d', { willReadFrequently: true });

  function attach(v) { video = v; }

  function stop() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
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

  return { attach: attach, start: start, stop: stop, flip: flip, current: current,
           size: size, live: live, crop: crop, toScreen: toScreen, coverMap: coverMap,
           frame: frame };
})();
