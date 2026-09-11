/* Sightline - turns per-frame detections into things with an identity.

   COCO-SSD gives a fresh, unordered list every pass. Without matching them
   up, a label would flicker and every frame would look like a brand new
   object to identify - which is both ugly and a waste of the daily API quota.
   Here each detection is matched to an existing track by overlap, boxes are
   smoothed toward their new position, and a track keeps its identified label
   for as long as it survives. */
'use strict';

var TRACK = (function () {

  var tracks = [];
  var nextId = 1;
  var MATCH_IOU = 0.3;
  var MAX_MISSES = 12;       // ~0.6s at 20fps before a track is dropped
  var SMOOTH = 0.35;

  function all() { return tracks; }
  function byId(id) { for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) return tracks[i]; return null; }

  function update(dets, now) {
    var used = {};

    /* Greedy best-overlap matching, strongest pairs first. */
    var pairs = [];
    tracks.forEach(function (t, ti) {
      dets.forEach(function (d, di) {
        var o = U.iou(t.box, d.box);
        if (o >= MATCH_IOU && t.cls === d.cls) pairs.push({ ti: ti, di: di, o: o });
      });
    });
    pairs.sort(function (a, b) { return b.o - a.o; });

    var tTaken = {}, dTaken = {};
    pairs.forEach(function (p) {
      if (tTaken[p.ti] || dTaken[p.di]) return;
      tTaken[p.ti] = dTaken[p.di] = true;
      var t = tracks[p.ti], d = dets[p.di];
      for (var i = 0; i < 4; i++) t.box[i] = U.lerp(t.box[i], d.box[i], SMOOTH);
      t.raw = d.box.slice();
      t.score = d.score;
      t.misses = 0;
      t.seen = now;
      used[t.id] = true;
    });

    /* Unmatched detections become new tracks. */
    dets.forEach(function (d, di) {
      if (dTaken[di]) return;
      tracks.push({
        id: nextId++,
        cls: d.cls,
        box: d.box.slice(),
        raw: d.box.slice(),
        score: d.score,
        born: now,
        seen: now,
        misses: 0,
        state: 'new',       // CLOUD state: new -> queued -> done | skipped | failed
        localState: '',     // ON-DEVICE state: '' -> busy -> done | stale | failed
        scan: 'plotted',    // plotted -> scanning -> relevant | dismissed
        why: '',            // why it was dismissed, shown on the target
        settled: 0,         // when the verdict landed, for the fade
        local: null,        // the on-device label, when one is confident enough
        tier: '',           // which tier owns the label showing right now
        labelMs: 0,         // ms from first sighting to first real label
        label: '',          // the fine-grained name, once we have one
        kicker: '',         // the category line above it
        data: null,         // the full detail record for the sheet
        reason: '',
        tries: 0
      });
    });

    /* Age out anything that stopped being seen. */
    tracks.forEach(function (t) { if (!used[t.id]) t.misses++; });
    tracks = tracks.filter(function (t) { return t.misses <= MAX_MISSES; });

    return tracks;
  }

  function reset() { tracks = []; }

  /* A track is worth spending a lookup on once it has held still long enough
     to be a real object rather than a one-frame blip. */
  function stable(t, now, ms) {
    return (now - t.born) >= (ms || 600) && t.misses === 0;
  }

  /* Which track did a tap land on? Smallest hit wins, so tapping a face
     inside a person box selects the face. */
  function hit(x, y) {
    var best = null, bestArea = Infinity;
    tracks.forEach(function (t) {
      var s = CAM.toScreen(t.box);
      if (x >= s[0] && x <= s[0] + s[2] && y >= s[1] && y <= s[1] + s[3]) {
        var a = s[2] * s[3];
        if (a < bestArea) { bestArea = a; best = t; }
      }
    });
    return best;
  }

  return { all: all, byId: byId, update: update, reset: reset, stable: stable, hit: hit };
})();
