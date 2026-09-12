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
const isRoads = body => /highway/.test(body);
const isBld   = body => /building/.test(body);

/* A real PNG, 256 square, one flat colour - so the tile can be seen to land
   on the canvas rather than merely be requested. */
const zlib = require('zlib');
function png(r, g, b) {
  const W = 256, H = 256, raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o+1] = g; raw[o+2] = b; } }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = buf => { let c = 0xffffffff; for (const b2 of buf) c = crcT[(c ^ b2) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE = png(200, 60, 60);

async function open(b, plan, tilePlan) {
  const ctx = await b.newContext({ permissions: ['geolocation'], geolocation: { latitude: 51.5074, longitude: -0.1278 },
                                   viewport: { width: 412, height: 892 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('crash', () => { crashed = crashed || 'the page crashed'; });
  await page.route('**/vendor/models/**', r => r.abort());
  await page.route(/overpass/, plan);
  await page.route(/tile\.openstreetmap\.org/, tilePlan || (r => r.fulfill({ status: 200, contentType: 'image/png',
                     headers: { 'Access-Control-Allow-Origin': '*' }, body: TILE })));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.MAP && window.MAPVIEW && window.ROADS && window.GEO, null, { timeout: 30000 });
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

  /* ---------- 1. the picture comes from tiles, and Overpass is not asked ---------- */
  console.log('\nOPENING THE MAP ASKS FOR TILES, NOT OVERPASS');
  {
    const overpass = [], tilesAsked = [];
    const { ctx, page } = await open(b,
      async r => { overpass.push(r.request().postData() || ''); return r.fulfill({ status: 200, contentType: 'application/json', body: roadsBody(3) }); },
      async r => { tilesAsked.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'image/png',
                     headers: { 'Access-Control-Allow-Origin': '*' }, body: TILE }); });
    /* The CORNER map is live the whole time and fetches its own roads and
       footprints for the 3D view - that is its job, not the page's. So
       let it settle, take the count, and then open the page: what the
       page adds is what is being measured. */
    await page.waitForTimeout(2500);
    const cornerAsked = overpass.length;
    await page.evaluate(() => { MAP.setOpen(true); MAPVIEW.draw(); });
    await page.waitForFunction(() => MAPVIEW._tiles().asked > 0 && MAPVIEW._tiles().pending === 0, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    const t = await page.evaluate(() => MAPVIEW._tiles());
    ok('tiles are asked for', tilesAsked.length > 0, tilesAsked.length);
    ok('only the ones on screen - a phone view is a couple of dozen, not hundreds',
       tilesAsked.length <= 40, tilesAsked.length);
    ok('every one is a real slippy-map address', tilesAsked.every(u => /\/\d+\/\d+\/\d+\.png$/.test(u)), tilesAsked.slice(0, 2));
    ok('at the zoom the view is at', tilesAsked.every(u => u.indexOf('/' + t.zoom + '/') > 0), { zoom: t.zoom, sample: tilesAsked[0] });
    ok('and opening the map page adds NO Overpass request of its own',
       overpass.length === cornerAsked, { corner: cornerAsked, afterOpening: overpass.length });

    /* The tile has to land on the canvas, not just be fetched. Its colour
       is inverted into the dark palette, so what is checked is that the
       middle is no longer the empty base and is fully painted. */
    const pix = await page.evaluate(() => {
      const c = document.getElementById('mapCanvas'), g = c.getContext('2d');
      const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    });
    ok('the tile is painted onto the canvas', pix.a === 255 && !(pix.r === 10 && pix.g === 17 && pix.b === 24), pix);

    /* Drawn again at the same view: nothing new is fetched. */
    const before = tilesAsked.length;
    await page.evaluate(() => { MAPVIEW.draw(); MAPVIEW.draw(); });
    await page.waitForTimeout(300);
    ok('drawing the same view again fetches nothing', tilesAsked.length === before, { before, after: tilesAsked.length });

    /* Pan a long way: new tiles, and only new ones. */
    await page.evaluate(() => { MAPVIEW._centre({ lat: 51.5310, lon: -0.1770 }); MAPVIEW.draw(); });
    await page.waitForTimeout(600);
    ok('panning somewhere new fetches the tiles for there', tilesAsked.length > before, { before, after: tilesAsked.length });
    ok('and still no Overpass, however far you pan', overpass.length === cornerAsked, { corner: cornerAsked, now: overpass.length });
    ok('CONTROL: the page never crashed', !crashed, crashed);
    await ctx.close();
  }

  /* ---------- 2. roads are asked for when there is somewhere to go ---------- */
  console.log('\nROAD GEOMETRY IS FOR ROUTING, AND COMES TWO AT A TIME');
  {
    let live = 0, peak = 0; const order = [];
    const { ctx, page } = await open(b, async r => {
      const body = r.request().postData() || '';
      live++; peak = Math.max(peak, live);
      order.push(isRoads(body) ? 'roads' : (isBld(body) ? 'bld' : 'other'));
      await new Promise(s => setTimeout(s, 220));
      live--;
      await r.fulfill({ status: 200, contentType: 'application/json', body: roadsBody(6) });
    });
    await page.waitForTimeout(2500);                 // the corner map's own asks
    const cornerN = order.length, cornerBld = order.filter(x => x === 'bld').length;
    await page.evaluate(() => {
      MAP.setOpen(true); MAPVIEW.setMpp(4);
      MAP.setDest({ title: 'Up The Road', lat: 51.515, lon: -0.13, dist: 800, bearing: 10 });
      MAPVIEW.draw();
    });
    await page.waitForTimeout(3500);
    ok('SETUP: with a destination set the roads are asked for', order.length >= cornerN + 3, { corner: cornerN, now: order.length });
    ok('never more than two requests are in flight at once', peak <= 2, { peak, sent: order.length });
    ok('and the map page adds no footprint request of its own',
       order.filter(x => x === 'bld').length === cornerBld, order.slice(cornerN));
    await ctx.close();
  }

  /* ---------- 3. busy is not broken ---------- */
  console.log('\nA REFUSAL IS A WAIT, NOT A VERDICT');
  {
    let roadCalls = 0;
    const { ctx, page } = await open(b, async r => {
      roadCalls++;
      /* Every slot taken, on BOTH mirrors. Only a build that waits and asks
         again ever gets the road. */
      if (roadCalls <= 2) return r.fulfill({ status: 429, contentType: 'text/plain',
                                             headers: { 'Retry-After': '3' }, body: 'slot unavailable' });
      return r.fulfill({ status: 200, contentType: 'application/json', body: roadsBody(7) });
    });
    await page.evaluate(() => {
      MAP.setOpen(true);
      MAP.setDest({ title: 'Up The Road', lat: 51.51, lon: -0.128, dist: 300, bearing: 0 });
      MAPVIEW.draw();
    });
    const got = await page.waitForFunction(() => ROADS.near().length > 0, null, { timeout: 25000 })
                          .then(() => true).catch(() => false);
    ok('every mirror busy still ends with the road on the map', got === true, { roadCalls, got });
    ok('SETUP: it really was refused, more than once', roadCalls >= 3, roadCalls);
    await ctx.close();
  }

  /* ---------- 4. the corner map still has its buildings ---------- */
  console.log('\nTHE CORNER MAP STILL GETS ITS 3D BUILDINGS');
  {
    const asked = [];
    const { ctx, page } = await open(b, async r => {
      const body = r.request().postData() || '';
      asked.push(isBld(body) ? 'bld' : 'roads');
      return r.fulfill({ status: 200, contentType: 'application/json', body: roadsBody(2) });
    });
    /* The corner map draws on its own; give it a moment with a position. */
    await page.evaluate(() => { MAP.setOpen(false); MAP.draw(); });
    await page.waitForTimeout(2500);
    ok('the corner map asks for footprints, because it draws them in 3D', asked.indexOf('bld') >= 0, asked);
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
