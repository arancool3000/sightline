/* Sightline - what the app is actually willing to claim.

   "always making mistakes, always pointing out the obvious, always acting
    dumb."

   All three are the same fault. A classifier asked about one frame ALWAYS
   returns its best of a thousand classes. It cannot answer "I do not know",
   it has no idea whether the thing in front of it is even in its
   vocabulary, and a single confident-looking number was being written on
   the screen as a fact. So a Maltipoo became a cocker spaniel, a 3D printer
   became a Polaroid camera, and a tennis ball got a label announcing a
   tennis ball.

   This is the judge. Nothing reaches the screen from the general classifier
   without passing it, and what it asks is not "what is your best guess" but:

     DOES IT KEEP SAYING THE SAME THING?
       One frame is an opinion. The same answer over several frames, as the
       camera shakes and the light changes, is evidence. A guess that cannot
       repeat itself is exactly the guess that should not be shown.

     DOES IT BEAT ITS OWN RUNNER-UP?
       A wide gap to the second answer means the model recognises this. A
       narrow one means it is torn between neighbours, which is what a
       crossbreed, a cultivar or an unknown object looks like from inside a
       fixed vocabulary.

     IS IT WORTH SAYING AT ALL?
       A specialist outranks a generalist, always. And a label that only
       repeats the word already on the box tells the reader nothing.

   Anything that fails is not a mistake to be shown quietly - it is not
   shown. Saying nothing is a correct answer.                              */
'use strict';

var EVIDENCE = (function () {

  /* Tuned to be hard to please. The cost of silence is a blank card; the
     cost of a wrong name is the owner not trusting any of them. */
  var NEED_VOTES = 2;        // separate looks that must agree
  var MIN_MEAN = 0.42;       // mean confidence across those looks
  var MIN_MARGIN = 0.14;     // mean gap to the runner-up
  var WINDOW_MS = 6000;      // how long a look stays evidence
  var SURE_MEAN = 0.70;      // above this, and a wide gap, one look is enough
  var SURE_MARGIN = 0.45;

  /* Where the answer came from, and who wins when two disagree. A species
     model that knows 2,102 plants beats a general classifier that knows
     about forty; a model that has seen the whole web beats both. */
  var RANK = { cloud: 400, species: 300, local: 100, guess: 10 };

  function rank(tier) { return RANK[tier] || 0; }

  /* A vote is one look at one track. */
  function record(t, name, score, margin, now) {
    if (!t.ev) t.ev = {};
    var e = t.ev[name];
    if (!e) e = t.ev[name] = { n: 0, score: 0, margin: 0, first: now, last: now };
    e.n++; e.score += score; e.margin += margin; e.last = now;

    /* Anything not seen lately stops counting - the camera has moved on. */
    Object.keys(t.ev).forEach(function (k) {
      if (now - t.ev[k].last > WINDOW_MS) delete t.ev[k];
    });
    return e;
  }

  /* What, if anything, this track has earned the right to be called. */
  function verdict(t, now) {
    if (!t.ev) return null;
    var best = null, bestName = '';
    Object.keys(t.ev).forEach(function (k) {
      var e = t.ev[k];
      var mean = e.score / e.n;
      /* A name seen many times at middling confidence should beat one seen
         once at high confidence, so votes count as well as strength. */
      var weight = mean * Math.min(3, e.n);
      if (!best || weight > best.weight) {
        best = { n: e.n, mean: mean, margin: e.margin / e.n, weight: weight, first: e.first };
        bestName = k;
      }
    });
    if (!best) return null;

    var sure = best.mean >= SURE_MEAN && best.margin >= SURE_MARGIN;
    if (!sure && best.n < NEED_VOTES) return { name: bestName, ready: false, why: 'looking again' };

    /* TORN IS CHECKED BEFORE WEAK, and the order matters.

       A crossbreed leaves the model split across several neighbours, so
       each of them scores low AND the gap between them collapses. Both
       tests fire, but only one of them produces something useful: "it could
       not separate these, and here they are". Testing confidence first
       buried that behind a flat "not confident enough". */
    if (best.margin < MIN_MARGIN) {
      return { name: bestName, ready: false, why: 'torn', torn: true,
               among: Object.keys(t.ev).sort(function (a, b) {
                 return (t.ev[b].score / t.ev[b].n) - (t.ev[a].score / t.ev[a].n);
               }).slice(0, 3) };
    }
    if (best.mean < MIN_MEAN) return { name: bestName, ready: false, why: 'not confident enough' };
    return { name: bestName, ready: true, n: best.n, score: best.mean, margin: best.margin };
  }

  /* Would putting this label on that track tell the reader anything? */
  function adds(label, cls) {
    var lab = String(label || '').toLowerCase().trim();
    var c = String(cls || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (!lab) return false;
    if (!c) return true;
    if (lab === c) return false;
    /* "dog" -> "golden retriever" adds something. "dog" -> "dogs" does not. */
    if (lab.indexOf(c) !== -1 && lab.split(/\s+/).length <= c.split(/\s+/).length) return false;
    return true;
  }

  /* Should this answer replace the one already on the track? */
  function accept(t, tier, name) {
    if (!name) return false;
    if (!adds(name, t.cls)) return false;
    if (!t.label) return true;
    if (rank(tier) > rank(t.tier)) return true;             // a better source
    if (rank(tier) < rank(t.tier)) return false;            // never downgrade
    return name !== t.label;                                 // same source, newer look
  }

  function clear(t) { delete t.ev; }

  return { record: record, verdict: verdict, adds: adds, accept: accept,
           clear: clear, rank: rank,
           _limits: { NEED_VOTES: NEED_VOTES, MIN_MEAN: MIN_MEAN,
                      MIN_MARGIN: MIN_MARGIN, SURE_MEAN: SURE_MEAN,
                      SURE_MARGIN: SURE_MARGIN, WINDOW_MS: WINDOW_MS } };
})();
