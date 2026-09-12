/* Two reports from the owner, both about the same thing:

     "it should use ar in real time for the boxes to follow the objects,
      and not get 2 boxes on 1 object both saying backpack"
     "it calls a tree outside our house a rapeseed, pot and valley at the
      same time"

   So: a card is attached to its object and moves with it, and one object
   gets exactly one card, whether the two claims came from the detector
   overlapping itself or from three grid regions covering one tree.

   The controls are as important as the assertions. "one card" is also true
   of a build that draws nothing, so the count is checked in both directions
   on every case.                                                          */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((q, res) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x === undefined ? '' : '  ' + JSON.stringify(x))); } };

(async () => {
  await new Promise(r => server.listen(8737, r));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  const ctx = await browser.newContext({ permissions: ['camera'], viewport: { width: 412, height: 892 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.slice(0, 140)));

  await page.goto('http://127.0.0.1:8737/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  /* Drive the layer directly with known boxes. The camera mapping is stubbed
     to the identity so a box in video space is the same box on screen and an
     assertion about position means what it says. */
  await page.evaluate(() => {
    CAM.toScreen = function (b) { return [b[0], b[1], b[2], b[3]]; };
    /* Labels are attached because a card is only drawn when there is
       something non-obvious to say - a bare "backpack" box gets a marker and
       no words, by design. The dedupe questions are about TARGETS; the card
       count is what the labels are for. */
    window.__plot = function (dets, labels) {
      TRACK.reset();
      TRACK.update(dets, performance.now());
      TRACK.all().forEach(function (t, i) {
        var l = labels ? labels[i % labels.length] : null;
        if (l) { t.label = l; t.tier = 'cloud'; t.scan = 'relevant'; }
      });
      UI.draw(TRACK.all());
      return TRACK.visible().length;
    };
    window.__cards = function () {
      return Array.prototype.map.call(document.querySelectorAll('#arLayer .ar-card'), function (el) {
        const r = el.getBoundingClientRect();
        return { text: el.querySelector('.ar-title').textContent, x: r.left, y: r.top, w: r.width, h: r.height };
      });
    };
  });

  let r;
  console.log('\nONE OBJECT, ONE CARD');

  /* The owner's own photograph, measured off it: one Adidas backpack, two
     boxes, IoU 0.32. The first version of this fix used a 0.5 bar and let
     both through, so these are its exact proportions, scaled to fit the
     test viewport (the first attempt used the photo's own pixel numbers,
     which fall outside a 412px screen and were culled as off-frame). */
  r = await page.evaluate(() => {
    const n = window.__plot([
      { cls: 'backpack', box: [26, 170, 218, 240], score: 0.72 },
      { cls: 'backpack', box: [136, 184, 211, 233], score: 0.66 }
    ], ['Mous Extreme Luggage']);
    const iou = U.iou([26, 170, 218, 240], [136, 184, 211, 233]);
    return { visible: n, cards: window.__cards(), iou: iou };
  });
  ok('SETUP: those two boxes really do overlap only loosely', r.iou > 0.28 && r.iou < 0.36, +r.iou.toFixed(3));
  ok("the owner's two-boxes-on-one-backpack case leaves ONE card", r.cards.length === 1, r.cards.map(c => c.text));

  console.log('\nNOT FOR LABELLING THE OBVIOUS');
  r = await page.evaluate(() => {
    // Exactly the owner's complaint: a detected tennis ball, named only by
    // the word already on the box.
    window.__plot([{ cls: 'sports ball', box: [140, 400, 70, 70], score: 0.88 }]);
    const bare = document.querySelectorAll('#arLayer .ar-card').length;

    // A guess about a square of the scene: "Tennis Ball", "Lemon".
    TRACK.reset();
    TRACK.update([{ cls: 'grid', box: [140, 400, 120, 120], score: 0.8 }], performance.now());
    const g = TRACK.all()[0];
    g.label = 'Lemon'; g.tier = 'guess'; g.conf = 0.74; g.scan = 'relevant';
    UI.draw(TRACK.all());
    const guess = document.querySelectorAll('#arLayer .ar-card').length;

    // The detail tier coming back with the same word it was given.
    TRACK.reset();
    TRACK.update([{ cls: 'backpack', box: [60, 300, 140, 180], score: 0.8 }], performance.now());
    const c = TRACK.all()[0];
    c.label = 'Backpack'; c.tier = 'cloud'; c.scan = 'relevant';
    UI.draw(TRACK.all());
    const echoed = document.querySelectorAll('#arLayer .ar-card').length;

    // On-device, but genuinely more than the box said.
    TRACK.reset();
    TRACK.update([{ cls: 'dog', box: [60, 300, 140, 180], score: 0.8 }], performance.now());
    const d = TRACK.all()[0];
    d.label = 'Golden Retriever'; d.tier = 'local'; d.scan = 'relevant';
    UI.draw(TRACK.all());
    const better = document.querySelectorAll('#arLayer .ar-card').length;

    return { bare, guess, echoed, better };
  });
  ok('a tennis ball named "sports ball" gets no card', r.bare === 0, r.bare);
  ok('a guess about a square of the scene gets no card', r.guess === 0, r.guess);
  ok('the detail tier echoing the box word back gets no card', r.echoed === 0, r.echoed);
  ok('CONTROL: "dog" becoming "Golden Retriever" DOES get a card', r.better === 1, r.better);

  /* The Maltipoo. The model cannot name it, and saying so IS the answer. */
  r = await page.evaluate(() => {
    TRACK.reset();
    TRACK.update([{ cls: 'dog', box: [60, 300, 160, 200], score: 0.9 }], performance.now());
    const t = TRACK.all()[0];
    t.torn = true; t.unsure = true; t.label = 'Cocker Spaniel'; t.tier = 'local';
    t.among = ['Cocker Spaniel', 'Toy Poodle', 'Maltese'];
    UI.draw(TRACK.all());
    const card = document.querySelector('#arLayer .ar-card');
    return { n: document.querySelectorAll('#arLayer .ar-card').length,
             title: card && card.querySelector('.ar-title').textContent,
             sub: card && card.querySelector('.ar-sub').textContent,
             cls: card && card.className };
  });
  ok('a crossbreed still gets a card', r.n === 1, r.n);
  ok('but it is not claimed as one breed', !!r.title && /cross of/i.test(r.title), r.title);
  ok('and the others are named', !!r.sub && /poodle/i.test(r.sub) && /maltese/i.test(r.sub), r.sub);
  ok('drawn in the unsettled style', !!r.cls && /\btorn\b/.test(r.cls), r.cls);

  /* ---- SILENCE IS NOT MODESTY ----

     "underconfident, under labelled."

     An answer the gate had not finished weighing was dropped outright, so
     the screen went quiet - and a reader cannot tell "I do not know" from
     "I am still looking" from "this thing is broken". It is said now, with
     the mark on it. The two assertions below pull in opposite directions
     on purpose: one fails a build that goes silent, the other fails a
     build that sounds certain. Neither passes alone. */
  r = await page.evaluate(() => {
    TRACK.reset();
    TRACK.update([{ cls: 'dog', box: [60, 300, 160, 200], score: 0.9 }], performance.now());
    const t = TRACK.all()[0];
    t.unsure = true; t.label = 'Golden Retriever'; t.tier = 'local';
    UI.draw(TRACK.all());
    const card = document.querySelector('#arLayer .ar-card');
    return { n: document.querySelectorAll('#arLayer .ar-card').length,
             title: card && card.querySelector('.ar-title').textContent,
             sub: card && card.querySelector('.ar-sub').textContent,
             cls: card && card.className };
  });
  ok('an answer still being weighed is shown, not swallowed', r.n === 1, r.n);
  ok('and it carries the mark instead of sounding certain',
     !!r.title && /\?\s*$/.test(r.title), r.title);
  ok('drawn in the unsettled style, not as a settled fact',
     !!r.cls && /\bprov\b/.test(r.cls), r.cls);

  /* CONTROL: hedging is not a licence to say the obvious. The whole reason
     the gate exists is that "backpack" over a backpack is not an answer,
     and a question mark does not make it one. */
  r = await page.evaluate(() => {
    TRACK.reset();
    TRACK.update([{ cls: 'backpack', box: [60, 300, 140, 180], score: 0.8 }], performance.now());
    const t = TRACK.all()[0];
    t.unsure = true; t.label = 'Backpack'; t.tier = 'local';
    UI.draw(TRACK.all());
    return document.querySelectorAll('#arLayer .ar-card').length;
  });
  ok('CONTROL: an unsure answer that only repeats the box word still says nothing', r === 0, r);

  /* CONTROL: a settled answer must NOT pick up the mark - otherwise
     everything becomes a maybe and the mark stops meaning anything. */
  r = await page.evaluate(() => {
    TRACK.reset();
    TRACK.update([{ cls: 'dog', box: [60, 300, 160, 200], score: 0.9 }], performance.now());
    const t = TRACK.all()[0];
    t.unsure = false; t.label = 'Golden Retriever'; t.tier = 'local';
    UI.draw(TRACK.all());
    const card = document.querySelector('#arLayer .ar-card');
    return { title: card && card.querySelector('.ar-title').textContent,
             cls: card && card.className };
  });
  ok('CONTROL: a settled answer is stated plainly, with no mark',
     !!r.title && !/\?/.test(r.title), r.title);

  /* CONTROL: torn about nothing is still nothing. */
  r = await page.evaluate(() => {
    TRACK.reset();
    TRACK.update([{ cls: 'backpack', box: [60, 300, 140, 180], score: 0.8 }], performance.now());
    const t = TRACK.all()[0];
    t.torn = true; t.unsure = true; t.among = ['Backpack', 'Backpacks'];
    UI.draw(TRACK.all());
    return document.querySelectorAll('#arLayer .ar-card').length;
  });
  ok('CONTROL: torn between the obvious and its plural says nothing', r === 0, r);

  /* And the other half of what the owner asked for: two backpacks, two signs. */
  r = await page.evaluate(() => {
    const n = window.__plot([
      { cls: 'backpack', box: [30, 500, 170, 220], score: 0.8 },
      { cls: 'backpack', box: [220, 510, 170, 220], score: 0.78 }
    ], ['Mous Extreme Luggage', 'Osprey Talon 22']);
    return { visible: n, cards: window.__cards() };
  });
  ok('two backpacks side by side get TWO cards', r.cards.length === 2, r.cards.map(c => c.text));

  /* People stand in front of each other for real, so they keep a strict bar. */
  r = await page.evaluate(() => {
    window.__plot([
      { cls: 'person', box: [80, 400, 150, 380], score: 0.9 },
      { cls: 'person', box: [130, 410, 150, 380], score: 0.86 }
    ], ['Ada Lovelace', 'Alan Turing']);
    return { cards: window.__cards().length, iou: U.iou([80,400,150,380],[130,410,150,380]) };
  });
  ok('SETUP: those two people overlap more than the backpacks did', r.iou > 0.36, +r.iou.toFixed(3));
  ok('two overlapping PEOPLE are still two people', r.cards === 2, r);

  // Two boxes on the same backpack, exactly the report.
  r = await page.evaluate(() => {
    const n = window.__plot([
      { cls: 'backpack', box: [100, 300, 140, 180], score: 0.81 },
      { cls: 'backpack', box: [112, 314, 132, 170], score: 0.74 }
    ], ['Mous Extreme Luggage']);
    return { visible: n, cards: window.__cards() };
  });
  ok('two overlapping backpack boxes leave ONE target', r.visible === 1, r.visible);
  ok('and draw ONE card, not two', r.cards.length === 1, r.cards.map(c => c.text));
  ok('CONTROL: that card is actually drawn', r.cards.length > 0 && r.cards[0].w > 20, r.cards[0]);

  // A small box wholly inside a big one is the same object with a low IoU.
  r = await page.evaluate(() => {
    const n = window.__plot([
      { cls: 'laptop', box: [60, 200, 300, 220], score: 0.9 },
      { cls: 'tv', box: [120, 240, 120, 90], score: 0.6 }
    ], ['MacBook Pro 14-inch M3', 'Sony Bravia XR']);
    return { visible: n, cards: window.__cards() };
  });
  ok('a box contained inside another is folded into it', r.visible === 1, r.visible);
  ok('the stronger claim is the one kept', r.cards.length === 1 && /MacBook/i.test(r.cards[0].text), r.cards.map(c => c.text));

  // CONTROL: genuinely separate objects must still each get a card.
  r = await page.evaluate(() => {
    const n = window.__plot([
      { cls: 'chair', box: [20, 120, 120, 160], score: 0.8 },
      { cls: 'person', box: [230, 400, 130, 300], score: 0.9 },
      { cls: 'bottle', box: [40, 640, 60, 120], score: 0.7 }
    ], ['Herman Miller Aeron', 'Ada Lovelace', 'Chateau Margaux 2015']);
    return { visible: n, cards: window.__cards() };
  });
  ok('CONTROL: three separate objects still get three targets', r.visible === 3, r.visible);
  ok('CONTROL: and three cards - the fix does not just delete labels', r.cards.length === 3, r.cards.map(c => c.text));

  console.log('\nTHE CARD FOLLOWS THE OBJECT');

  r = await page.evaluate(() => {
    TRACK.reset();
    const now = performance.now();
    // Same track, moved across the frame. The tracker smooths, so it is
    // stepped several times and the LAST position is what matters.
    let before = null;
    TRACK.update([{ cls: 'bottle', box: [40, 200, 80, 160], score: 0.9 }], now);
    const lbl = TRACK.all()[0];
    lbl.label = 'Chateau Margaux 2015'; lbl.tier = 'cloud'; lbl.scan = 'relevant';
    UI.draw(TRACK.all());
    before = window.__cards()[0];
    /* Moved a step at a time, not teleported. A box that jumps the width of
       the screen in one frame is a DIFFERENT object as far as the tracker is
       concerned - correctly - and it would lose its identity along with its
       label, which is what this is trying to watch follow it. */
    for (let i = 1; i <= 24; i++) {
      TRACK.update([{ cls: 'bottle', box: [40 + i * 10, 200 + i * 15, 80, 160], score: 0.9 }], now + i * 30);
      UI.draw(TRACK.all());
    }
    const after = window.__cards()[0];
    const t = TRACK.visible()[0];
    return { before: before, after: after, tracks: TRACK.visible().length, box: t && t.box,
             kept: !!(t && t.label) };
  });
  ok('it is still one target after moving', r.tracks === 1, r.tracks);
  ok('CONTROL: and it kept the name it was given', r.kept === true, r.kept);
  ok('the card moved right with the object', r.after.x - r.before.x > 120, { from: Math.round(r.before.x), to: Math.round(r.after.x) });
  /* Not "moved down by at least N": which side of the box the card sits on
     is a placement decision that flips when the card grows a line, and a
     pin on it went red for a taller card. The property is that it is
     still WITH its object - within the box's own height of it. */
  ok('the card is still on its object after the move',
     !!r.box && Math.abs(r.after.y - r.box[1]) < r.box[3] + 60,
     { cardY: Math.round(r.after.y), boxY: Math.round(r.box ? r.box[1] : -1), boxH: r.box && r.box[3] });
  ok('the card sits horizontally over its object', Math.abs((r.after.x + r.after.w / 2) - (r.box[0] + r.box[2] / 2)) < 40,
     { card: Math.round(r.after.x + r.after.w / 2), obj: Math.round(r.box[0] + r.box[2] / 2) });
  ok('the card sits just above its object, not floating elsewhere',
     r.after.y + r.after.h <= r.box[1] + 2 && r.box[1] - (r.after.y + r.after.h) < 40,
     { cardBottom: Math.round(r.after.y + r.after.h), objTop: Math.round(r.box[1]) });

  console.log('\nCARDS ARE RECYCLED, NOT REBUILT');
  r = await page.evaluate(() => {
    TRACK.reset();
    const now = performance.now();
    TRACK.update([{ cls: 'cup', box: [100, 300, 90, 110], score: 0.8 }], now);
    const c0 = TRACK.all()[0];
    c0.label = 'Le Creuset Stoneware'; c0.tier = 'cloud'; c0.scan = 'relevant';
    UI.draw(TRACK.all());
    const first = document.querySelector('#arLayer .ar-card');
    first.dataset.mark = 'same-node';
    for (let i = 0; i < 10; i++) {
      TRACK.update([{ cls: 'cup', box: [100 + i * 4, 300, 90, 110], score: 0.8 }], now + i * 30);
      UI.draw(TRACK.all());
    }
    const later = document.querySelector('#arLayer .ar-card');
    return { same: later && later.dataset.mark === 'same-node', count: document.querySelectorAll('#arLayer .ar-card').length };
  });
  ok('the same element is moved, not rebuilt each frame', r.same === true, r);
  ok('and no orphan cards accumulate', r.count === 1, r.count);

  console.log('\nCARDS ARE REMOVED WITH THEIR OBJECT');
  r = await page.evaluate(() => {
    TRACK.reset();
    let now = performance.now();
    TRACK.update([{ cls: 'cup', box: [100, 300, 90, 110], score: 0.8 }], now);
    const c1 = TRACK.all()[0];
    c1.label = 'Le Creuset Stoneware'; c1.tier = 'cloud'; c1.scan = 'relevant';
    UI.draw(TRACK.all());
    const had = document.querySelectorAll('#arLayer .ar-card').length;
    for (let i = 0; i < 30; i++) { now += 40; TRACK.update([], now); UI.draw(TRACK.all()); }
    return { had: had, now: document.querySelectorAll('#arLayer .ar-card').length };
  });
  ok('CONTROL: there was a card to remove', r.had === 1, r.had);
  ok('the card goes when the object does', r.now === 0, r.now);

  console.log('\nONE TREE, ONE ANSWER  (the grid sweep)');
  r = await page.evaluate(() => {
    // Three overlapping regions over one subject, each with its own guess -
    // exactly the "rapeseed, pot and valley" report.
    const now = performance.now();
    const hits = [
      { idx: 0, box: [0, 0, 300, 300], name: 'Rapeseed', score: 0.62, kind: 'plant', at: now },
      { idx: 1, box: [40, 30, 300, 300], name: 'Pot', score: 0.58, kind: 'object', at: now },
      { idx: 2, box: [20, 10, 320, 320], name: 'Valley', score: 0.71, kind: 'object', at: now }
    ];
    LOCAL._testGridSeed(hits);
    const out = LOCAL._testGridTargets();      // the real door, not the helper
    return { kept: out.length, names: out.map(h => h.name) };
  });
  ok('three overlapping regions collapse to one answer', r.kept === 1, r);
  ok('and it is the strongest of them', r.names[0] === 'Valley', r.names);

  r = await page.evaluate(() => {
    const now = performance.now();
    const hits = [
      { idx: 0, box: [0, 0, 200, 200], name: 'Rapeseed', score: 0.62, kind: 'plant', at: now },
      { idx: 5, box: [400, 400, 200, 200], name: 'Chair', score: 0.66, kind: 'object', at: now }
    ];
    LOCAL._testGridSeed(hits);
    return LOCAL._testGridTargets().length;
  });
  ok('CONTROL: two regions on DIFFERENT parts of the scene both survive', r === 2, r);

  console.log('\nA GUESS THAT CANNOT REPEAT ITSELF IS NOT SHOWN');
  r = await page.evaluate(async () => {
    // A canvas is drawable and can carry the two properties gridStep reads,
    // so the real gridStep runs against it.
    const v = document.createElement('canvas');
    v.width = 640; v.height = 480;
    v.videoWidth = 640; v.videoHeight = 480;
    /* Give it structure. A blank canvas is correctly rejected now as "no
       object here", which is the point of the detail guard - so a fixture
       that is flat black would be testing the wrong thing. */
    const g = v.getContext('2d');
    for (let y = 0; y < 480; y += 12) for (let x = 0; x < 640; x += 12) {
      g.fillStyle = ((x + y) / 12) % 2 ? '#e8e2d6' : '#2a2f3a';
      g.fillRect(x, y, 12, 12);
    }
    const wait = () => new Promise(r => setTimeout(r, 30));

    // Case 1: the same region answers differently every pass.
    const flip = ['rapeseed', 'pot', 'valley', 'cotton candy'];
    let i = 0;
    LOCAL._testSetNet(() => Promise.resolve([{ className: flip[i++ % flip.length], probability: 0.9 }]));
    for (let k = 0; k < 9; k++) { LOCAL.gridStep(v); await wait(); }   // one full sweep
    for (let k = 0; k < 9; k++) { LOCAL.gridStep(v); await wait(); }   // second sweep, new answers
    const unstable = LOCAL._testGridTargets().length;

    // Case 2: the same region answers the same thing twice.
    LOCAL._testSetNet(() => Promise.resolve([{ className: 'espresso maker', probability: 0.9 }]));
    for (let k = 0; k < 9; k++) { LOCAL.gridStep(v); await wait(); }
    for (let k = 0; k < 9; k++) { LOCAL.gridStep(v); await wait(); }
    const steady = LOCAL._testGridTargets();

    return { unstable: unstable, steady: steady.length, name: steady[0] && steady[0].name };
  });
  ok('a region that says something different every pass shows nothing', r.unstable === 0, r.unstable);
  ok('CONTROL: a region that repeats itself IS believed', r.steady >= 1, r);
  ok('CONTROL: and it is the answer it kept giving', /espresso/i.test(r.name || ''), r.name);

  r = await page.evaluate(() => {
    const flat = document.createElement('canvas');
    flat.width = 224; flat.height = 224;
    const g = flat.getContext('2d'); g.fillStyle = '#d8d2c6'; g.fillRect(0, 0, 224, 224);
    const busy = document.createElement('canvas');
    busy.width = 224; busy.height = 224;
    const h = busy.getContext('2d');
    for (let y = 0; y < 224; y += 8) for (let x = 0; x < 224; x += 8) {
      h.fillStyle = ((x + y) / 8) % 2 ? '#eee' : '#222'; h.fillRect(x, y, 8, 8);
    }
    return { flat: LOCAL._testDetail(flat), busy: LOCAL._testDetail(busy) };
  });
  ok('a flat crop - carpet, wall, sky - is not sent to be named', r.flat === false, r);
  ok('CONTROL: a crop with something in it still is', r.busy === true, r);

  ok('no page errors throughout', errs.length === 0, errs);

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
})();
