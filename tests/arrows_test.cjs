/* "arrows look strange... diagonal..."

   They were a flat glyph drawn in SCREEN space and rotated by
   atan2(g1.y - g0.y, g1.x - g0.x) - an angle measured in pixels. The
   perspective divide squashes vertical differences far harder than
   horizontal ones, so the moment you are not standing exactly on the
   road's centreline the x term dominates and the whole chevron swings
   toward the horizontal.

   And you are NEVER on the centreline. OpenStreetMap's way is the middle
   of the road; you are on the pavement, three or four metres to one side.
   So the fault showed on every straight road, which is why it read as
   "strange" rather than as a curve being wrong.

   That is what this suite stands on the pavement for. A chevron lying flat
   on a road running away from you has its two tails at the SAME distance,
   so they land at the same height on the screen, and it is wider than it
   is tall because the ground is being seen almost edge-on. A rotated glyph
   is neither.                                                             */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.json':'application/json', '.svg':'image/svg+xml' };
const server = http.createServer((q, res) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
                          else { fail++; console.log('  FAIL ' + n + (x === undefined ? '' : '  ' + JSON.stringify(x))); } };

/* A dead straight road running north, and nothing else. Real Overpass is
   never touched. */
const HERE = { lat: 51.5074, lon: -0.1278 };
function straightRoad() {
  const g = [];
  for (let i = 0; i < 60; i++) g.push({ lat: HERE.lat + i * 0.00006, lon: HERE.lon });   // ~400m north
  return JSON.stringify({ version: 0.6,
    elements: [{ type: 'way', id: 1, tags: { highway: 'residential', name: 'Straight Street' }, geometry: g }] });
}
/* The same road, bending to the right half way along. */
function bendingRoad() {
  const g = []; let lat = HERE.lat, lon = HERE.lon;
  for (let i = 0; i < 60; i++) {
    g.push({ lat: lat, lon: lon });
    lat += 0.00006;
    if (i > 25) lon += 0.00004 * (i - 25) / 10;
  }
  return JSON.stringify({ version: 0.6,
    elements: [{ type: 'way', id: 2, tags: { highway: 'residential', name: 'Bending Street' }, geometry: g }] });
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const BASE = 'http://127.0.0.1:' + server.address().port + '/';
  const { chromium } = require('playwright');
  const b = await chromium.launch();

  async function shapes(roadBody, sideMetres) {
    const ctx = await b.newContext({ viewport: { width: 412, height: 892 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message.slice(0, 140)));
    await page.route('**/vendor/models/**', r => r.abort());
    await page.route(/overpass/, r => r.fulfill({ status: 200, contentType: 'application/json', body: roadBody }));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.UI && window.MAP && window.GEO && window.ROADS && window.ROUTE,
                               null, { timeout: 30000 });
    const out = await page.evaluate(async ([here, side]) => {
      try { localStorage.removeItem('sightline.roads.v1'); } catch (e) {}
      const g = document.getElementById('gate'); if (g) { g.classList.add('hidden'); g.hidden = true; }
      /* Standing on the PAVEMENT: the road's centreline is `side` metres to
         the west of where the walker is. This is the ordinary case, and the
         one the old maths got wrong. */
      const mPerLon = 111320 * Math.cos(here.lat * Math.PI / 180);
      const me = { lat: here.lat, lon: here.lon + side / mPerLon, acc: 6 };
      GEO._set(me, 0, []);                                   // facing north, along the road
      ROADS.ensure(me.lat, me.lon, false);
      await new Promise(r => setTimeout(r, 1200));
      MAP.setDest({ title: 'Up The Road', lat: here.lat + 0.0030, lon: here.lon, dist: 330, bearing: 0 });
      CAM.toScreen = b2 => b2;
      UI.resize();
      for (let i = 0; i < 4; i++) { UI.draw([]); await new Promise(r => setTimeout(r, 260)); }
      return { shapes: UI._navShapes(), roads: ROADS.near().length, route: !!ROUTE.get() };
    }, [HERE, sideMetres]);
    await ctx.close();
    return { ...out, errs };
  }

  console.log('\nSTANDING ON THE PAVEMENT OF A STRAIGHT ROAD');
  {
    const r = await shapes(straightRoad(), 4);
    ok('SETUP: the road arrived and a route was planned', r.roads > 0 && r.route === true,
       { roads: r.roads, route: r.route });
    ok('SETUP: there are chevrons to measure', r.shapes.length >= 2, r.shapes.length);

    /* A flat marking on a road running away from you: both tails are the
       same distance off, so they sit at the same height. A glyph rotated in
       screen space tilts, and this is the number that says so. */
    const tilt = r.shapes.map(s => Math.abs(s.left[1] - s.right[1]));
    const worst = Math.max.apply(null, tilt);
    ok('the two tails of every chevron sit level, so it lies on the road',
       worst < 6, { worstTailDropPx: Math.round(worst), tilt: tilt.map(Math.round) });

    ok('and the tip is further away than the tails, not off to one side',
       r.shapes.every(s => s.tip[1] < s.left[1] && s.tip[1] < s.right[1]),
       r.shapes.map(s => ({ tip: Math.round(s.tip[1]), tails: Math.round((s.left[1] + s.right[1]) / 2) })));

    /* Seen almost edge-on, a square on the ground is a wide sliver. */
    const ratio = r.shapes.map(s => {
      const w = Math.abs(s.right[0] - s.left[0]);
      const hh = Math.abs(((s.left[1] + s.right[1]) / 2) - s.tip[1]);
      return hh > 0.01 ? w / hh : 99;
    });
    ok('each one is foreshortened - wider across than deep',
       ratio.every(v => v > 1.2), ratio.map(v => +v.toFixed(2)));

    /* CONTROL: they must still be laid ALONG the road, not simply squashed
       flat wherever the walker happens to look. */
    const ys = r.shapes.map(s => s.tip[1]);
    ok('CONTROL: they march away into the distance, one behind the other',
       ys.every((v, i) => i === 0 || v < ys[i - 1] + 2), ys.map(Math.round));
    ok('CONTROL: no page errors', r.errs.length === 0, r.errs);
  }

  console.log('\nAND WHERE THE ROAD BENDS, THEY BEND WITH IT');
  {
    const r = await shapes(bendingRoad(), 4);
    ok('SETUP: chevrons on the bending road too', r.shapes.length >= 3, r.shapes.length);
    /* The far ones are past the bend, so they must have moved across the
       screen relative to the near ones. A build that points every chevron
       the same way fails this. */
    const near = r.shapes[0], far = r.shapes[r.shapes.length - 1];
    const drift = far.tip[0] - near.tip[0];
    ok('the far chevrons follow the bend instead of staying in a straight line',
       Math.abs(drift) > 4, { driftPx: Math.round(drift) });
    ok('CONTROL: they are still on the ground, not tipped up',
       r.shapes.every(s => s.tip[1] < Math.max(s.left[1], s.right[1])),
       r.shapes.map(s => Math.round(s.tip[1])));
  }

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  await b.close(); server.close(); process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('  FAIL the suite could not finish  ' + JSON.stringify(String(e && e.message || e).split('\n')[0]));
  console.log('\n' + pass + '/' + (pass + fail + 1) + ' passed');
  process.exit(1);
});
