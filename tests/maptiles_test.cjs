/* "map boxes load super slowly."

   Measured before touching anything, with a 393 KB tile already in hand:
   first box on screen 55ms, a redraw of 600 buildings and 120 roads 6ms,
   storing the tile 0.8ms. None of the wait was ours - it was the round
   trip, and how we were asking for it.

   Overpass serves two requests at a time from one address. A wide view
   fired nine, seven were refused, and a refusal blacklisted that tile for
   ten minutes. Roads and buildings came in one response so nothing showed
   until all of it had. And buildings were fetched whether or not they
   would ever be drawn.

   This suite is about the asking. It never talks to Overpass - every
   answer is stubbed here, and what is recorded is what we sent, in what
   order, how many at once, and what we did when we were refused.        */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.json':'application/json', '.svg':'image/svg+xml', '.wasm':'application/wasm' };
const server = http.createServer((q, res) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

let pass = 0, fail = 0, crashed = '';
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
                          else { fail++; console.log('  FAIL ' + n + (x === undefined ? '' : '  ' + JSON.stringify(x))); } };

/* Answers that look like Overpass without being large enough to slow the
   suite down. The shape is what matters, not the count. */
function roadsBody(n) {
  const els = [];
  for (let i = 0; i < n; i++) {
    const g = []; for (let j = 0; j < 8; j++) g.push({ lat: 51.5074 + j * 0.0002, lon: -0.1278 + i * 0.0003 });
    els.push({ type: 'way', id: 900000 + i, tags: { highway: 'residential', name: 'Road ' + i }, geometry: g });
  }
  return JSON.stringify({ version: 0.6, elements: els });
}
function bldBody(n) {
  const els = [];
  for (let i = 0; i < n; i++) {
    const la = 51.5074 + (i % 20) * 0.00015, lo = -0.1278 + Math.floor(i / 20) * 0.00018;
    const g = []; for (let j = 0; j < 7; j++) g.push({ lat: la + Math.sin(j) * 0.00006, lon: lo + Math.cos(j) * 0.00007 });
    g.push(g[0]);
    els.push({ type: 'way', id: i, tags: { building: 'yes', 'building:levels': '3' }, geometry: g });
  }
  return JSON.stringify({ version: 0.6, elements: els });
}
const isRoads = body => /highway/.test(body);

async function open(b, plan) {
  const ctx = await b.newContext({ permissions: ['geolocation'], geolocation: { latitude: 51.5074, longitude: -0.1278 },
                                   viewport: { width: 412, height: 892 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('crash', () => { crashed = crashed || 'the page crashed'; });
  await page.route('**/vendor/models/**', r => r.abort());
  await page.route(/overpass/, plan);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.MAP && window.MAPVIEW && window.ROADS && window.GEO,
                             null, { timeout: 30000 });
  await page.evaluate(() => {
    const g = document.getElementById('gate'); if (g) { g.classList.add('hidden'); g.hidden = true; }
    try { localStorage.removeItem('sightline.roads.v1'); } catch (e) {}
    GEO._set({ lat: 51.5074, lon: -0.1278, acc: 12 }, 40, [], { temp: 16, code: 1, wind: 12 });
  });
  return { ctx, page };
}
let BASE = '';

(async () => {
  await new Promise(r => server.listen(0, r));
  BASE = 'http://127.0.0.1:' + server.address().port + '/';
  const { chromium } = require('playwright');
  const b = await chromium.launch();

  /* ---------- 1. two at a time, roads first ---------- */
  console.log('\nHOW MANY AT ONCE, AND IN WHAT ORDER');
  {
    let live = 0, peak = 0; const order = [];
    const { ctx, page } = await open(b, async r => {
      const body = r.request().postData() || '';
      live++; peak = Math.max(peak, live);
      order.push(isRoads(body) ? 'roads' : 'bld');
      await new Promise(s => setTimeout(s, 220));       // a round trip that is not instant
      live--;
      await r.fulfill({ status: 200, contentType: 'application/json',
                        body: isRoads(body) ? roadsBody(6) : bldBody(10) });
    });
    /* Zoom out far enough that the view wants the 3x3 of tiles - which is
       what used to fire nine requests at once. */
    /* 412px across at 4 m/px is ~1650m, past the 1200m line, so the view
       wants the 3x3 - which is the case that used to fire nine at once. */
    const wide = await page.evaluate(() => {
      MAP.setOpen(true); MAPVIEW.setMpp(4); MAPVIEW.draw();
      return { mpp: MAPVIEW.state().mpp, acrossM: Math.round(412 * MAPVIEW.state().mpp) };
    });
    ok('SETUP: the view is wide enough to want a block of tiles',
       wide.acrossM > 1200 && wide.acrossM <= 2600, wide);
    await page.waitForTimeout(3500);
    ok('SETUP: the wide view really does want several tiles', order.length >= 4, order.length);
    ok('never more than two requests are in flight at once', peak <= 2, { peak, sent: order.length });
    const firstBld = order.indexOf('bld');
    ok('every street request goes out before the first building request',
       firstBld === -1 || order.slice(0, firstBld).every(x => x === 'roads'),
       order.slice(0, Math.min(12, order.length)));
    await ctx.close();
  }

  /* ---------- 2. streets are on screen before the boxes ---------- */
  console.log('\nTHE STREETS DO NOT WAIT FOR THE BOXES');
  {
    let releaseBld;
    const held = new Promise(r => { releaseBld = r; });
    const { ctx, page } = await open(b, async r => {
      const body = r.request().postData() || '';
      if (isRoads(body)) return r.fulfill({ status: 200, contentType: 'application/json', body: roadsBody(9) });
      await held;                                        // the slow half
      return r.fulfill({ status: 200, contentType: 'application/json', body: bldBody(12) });
    });
    await page.evaluate(() => MAP.setOpen(true));
    await page.waitForFunction(() => ROADS.near().length > 0, null, { timeout: 20000 }).catch(() => {});
    const mid = await page.evaluate(() => ({ roads: ROADS.near().length, bld: ROADS.buildings().length,
                                             pending: ROADS.pending() }));
    ok('the streets are held while the buildings are still coming',
       mid.roads > 0 && mid.bld === 0, mid);
    ok('and the map says which half it is still waiting for',
       mid.pending.buildings + mid.pending.queued > 0, mid.pending);
    releaseBld();
    await page.waitForFunction(() => ROADS.buildings().length > 0, null, { timeout: 20000 }).catch(() => {});
    const end = await page.evaluate(() => ({ roads: ROADS.near().length, bld: ROADS.buildings().length }));
    ok('CONTROL: the boxes do arrive, and the streets are still there',
       end.bld > 0 && end.roads > 0, end);
    await ctx.close();
  }

  /* ---------- 3. nothing is fetched for a layer that is off ---------- */
  console.log('\nWHAT IS NOT DRAWN IS NOT DOWNLOADED');
  {
    const sent = [];
    const { ctx, page } = await open(b, async r => {
      const body = r.request().postData() || '';
      sent.push(isRoads(body) ? 'roads' : 'bld');
      return r.fulfill({ status: 200, contentType: 'application/json',
                         body: isRoads(body) ? roadsBody(5) : bldBody(8) });
    });
    /* Pressed the way a finger presses it, so a chip that stopped being
       wired reads as a failure rather than a pass. */
    const off = await page.evaluate(() => {
      MAP.setOpen(true);
      const btn = document.getElementById('layer-buildings');
      if (!btn) return { no: 'no chip' };
      if (MAPVIEW.state().layers.buildings) btn.click();
      MAPVIEW.draw();
      return { on: !!MAPVIEW.state().layers.buildings };
    });
    ok('SETUP: the buildings chip really turned the layer off', off.on === false, off);
    await page.waitForTimeout(2000);
    ok('SETUP: the streets were still asked for', sent.indexOf('roads') >= 0, sent);

    /* Opening the map at all fetches the tile you are standing in, with
       whatever the layers were then - so asking "was a footprint ever
       requested" answers about that first tile, not about the switch.
       Move somewhere NEW with the layer off, and watch only that. */
    sent.length = 0;
    await page.evaluate(() => {
      MAPVIEW._centre({ lat: 51.5310, lon: -0.1770 });   // a mile away: a fresh tile
      MAPVIEW.draw();
    });
    await page.waitForTimeout(2500);
    ok('SETUP: somewhere new really is asked about', sent.indexOf('roads') >= 0, sent);
    ok('with the buildings layer off, no footprint is requested',
       sent.indexOf('bld') < 0, sent);
    /* CONTROL: turning it back on must ask - a memo that never expires is
       how a switched-on layer stays empty. */
    const on = await page.evaluate(() => {
      document.getElementById('layer-buildings').click();
      MAPVIEW.draw();
      return { on: !!MAPVIEW.state().layers.buildings };
    });
    ok('SETUP: and back on again', on.on === true, on);
    await page.waitForTimeout(2500);
    ok('CONTROL: switching the layer on asks for them', sent.indexOf('bld') >= 0, sent);
    await ctx.close();
  }

  /* ---------- 4. busy is not broken ---------- */
  console.log('\nA REFUSAL IS A WAIT, NOT A VERDICT');
  {
    let roadCalls = 0;
    const { ctx, page } = await open(b, async r => {
      const body = r.request().postData() || '';
      if (!isRoads(body)) return r.fulfill({ status: 200, contentType: 'application/json', body: bldBody(4) });
      roadCalls++;
      /* Overpass under load: every slot taken, on BOTH mirrors.
         Refusing only the first is not a discriminator - a build that
         treats 429 as a failure simply falls through to the second mirror
         and looks fine. With both busy, only a build that waits and asks
         again ever gets the road. */
      if (roadCalls <= 2) return r.fulfill({ status: 429, contentType: 'text/plain',
                                             headers: { 'Retry-After': '3' }, body: 'slot unavailable' });
      return r.fulfill({ status: 200, contentType: 'application/json', body: roadsBody(7) });
    });
    await page.evaluate(() => MAP.setOpen(true));
    const got = await page.waitForFunction(() => ROADS.near().length > 0, null, { timeout: 25000 })
                          .then(() => true).catch(() => false);
    ok('every mirror busy still ends with the road on the map', got === true,
       { roadCalls, roads: await page.evaluate(() => ROADS.near().length) });
    ok('SETUP: it really was refused, more than once', roadCalls >= 3, roadCalls);
    await ctx.close();
  }

  done(b);
})().catch(e => {
  const why = crashed || String(e && e.message || e).split('\n')[0];
  fail++;
  console.log('  FAIL the suite could not finish  ' + JSON.stringify(why));
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(1);
});

function done(b) {
  if (crashed) ok('the page never crashed', false, crashed);
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  b.close().catch(() => {}); server.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
}
