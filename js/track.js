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

    dedupe();
    return tracks;
  }

  /* One object, one answer.

     Two things produced two labels on one thing. The detector can return
     overlapping boxes for the same object under different classes - a
     backpack that is also scored as a handbag - and each became its own
     target. And the grid sweep samples nine overlapping regions, so a tree
     filling the frame was in three of them and came back "rapeseed", "pot"
     and "valley" at once, each as a separate card.

     So after matching, overlapping targets are collapsed: the strongest one
     survives and the rest are marked as duplicates of it. They are kept in
     the tracker (dropping them would make them reappear next frame) but
     they are not drawn and cannot be tapped.

     Containment matters as much as overlap here: a small box wholly inside
     a large one has a LOW IoU while plainly being the same object. */
  /* Measured against the real case rather than guessed: the owner's photo of
     ONE backpack produced two boxes at IoU 0.32 and 0.49 containment, which
     sailed under a 0.5 / 0.7 rule. Two SEPARATE backpacks side by side are a
     different picture - they barely touch - so the bar for "same class, same
     thing" can come down a long way without merging two real objects.

     People are the exception and keep the strict numbers: a crowd is full of
     genuinely different people who genuinely overlap, and merging two of them
     would be worse than showing two cards on one person.

     The rule the owner stated: one backpack, one sign; two backpacks, two
     signs. */
  var SAME = { iou: 0.25, inside: 0.55 };     // same class - almost certainly one thing
  var CROSS = { iou: 0.5, inside: 0.7 };      // different classes - one thing under two names
  var CROWD = { iou: 0.55, inside: 0.85 };    // people, who really do stand in front of each other
  var CROWDED = { person: 1 };

  function limits(a, b) {
    if (CROWDED[a.cls] || CROWDED[b.cls]) return CROWD;
    return a.cls === b.cls ? SAME : CROSS;
  }

  function overlapping(a, b) {
    var lim = limits(a, b);
    if (U.iou(a.box, b.box) >= lim.iou) return true;
    var ax = Math.max(a.box[0], b.box[0]), ay = Math.max(a.box[1], b.box[1]);
    var bx = Math.min(a.box[0] + a.box[2], b.box[0] + b.box[2]);
    var by = Math.min(a.box[1] + a.box[3], b.box[1] + b.box[3]);
    var inter = Math.max(0, bx - ax) * Math.max(0, by - ay);
    if (!inter) return false;
    var areaA = a.box[2] * a.box[3], areaB = b.box[2] * b.box[3];
    return inter / Math.min(areaA, areaB) >= lim.inside;
  }

  /* Which of two overlapping targets is the better answer. A named one beats
     an unnamed one, a cloud answer beats a device guess, then confidence,
     then the one we have had longest - so the surviving card does not
     flicker between two near-equal candidates frame to frame. */
  function rank(t) {
    return (t.tier === 'cloud' ? 4000 : 0) +
           (t.label ? 2000 : 0) +
           (t.scan === 'dismissed' ? -1000 : 0) +
           Math.round((t.score || 0) * 100);
  }

  function dedupe() {
    tracks.forEach(function (t) { t.dup = 0; });
    var order = tracks.slice().sort(function (a, b) {
      var d = rank(b) - rank(a);
      return d !== 0 ? d : a.id - b.id;          // stable, so it does not flip
    });
    for (var i = 0; i < order.length; i++) {
      var win = order[i];
      if (win.dup) continue;
      for (var j = i + 1; j < order.length; j++) {
        var other = order[j];
        if (other.dup) continue;
        if (overlapping(win, other)) other.dup = win.id;
      }
    }
  }

  function visible() {
    return tracks.filter(function (t) { return !t.dup; });
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
    visible().forEach(function (t) {
      var s = CAM.toScreen(t.box);
      if (x >= s[0] && x <= s[0] + s[2] && y >= s[1] && y <= s[1] + s[3]) {
        var a = s[2] * s[3];
        if (a < bestArea) { bestArea = a; best = t; }
      }
    });
    return best;
  }

  return { all: all, visible: visible, byId: byId, update: update, reset: reset,
           stable: stable, hit: hit, overlapping: overlapping };
})();
