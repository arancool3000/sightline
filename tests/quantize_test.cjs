/* Does shrinking the weights change what the models SAY?

   The weights were re-stored as uint8 with a per-tensor scale so the app
   downloads 6 MB instead of 23 MB. That is only worth having if the answers
   are the same, so this runs the SAME fixed input through the original
   float32 model and the quantised one and compares the outputs.

   The comparison is on raw model output, not on a photograph, deliberately:
   a photograph would test the detector's taste, and what is in question here
   is arithmetic.

   The controls matter as much as the assertions. A test that only says
   "the two agree" would also pass if both models returned zeros, so the
   spread of the reference output is checked first.                        */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((q, res) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

let pass = 0, fail = 0;
const ok = (name, cond, got) => { if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (got === undefined ? '' : '  ' + JSON.stringify(got))); } };

(async () => {
  await new Promise(r => server.listen(8736, r));
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  page error: ' + e.message.slice(0, 160)));

  await page.goto('http://127.0.0.1:8736/tests/fixtures/bare.html');
  await page.waitForFunction(() => window.tf && typeof tf.loadLayersModel === 'function', null, { timeout: 60000 });
  await page.evaluate(() => tf.setBackend('cpu'));

  console.log('\nCLASSIFIER  (mobilenet v1 0.50, 224x224)');
  const mnet = await page.evaluate(async () => {
    // A fixed, reproducible input. Not noise-random: a smooth gradient plus a
    // deterministic ripple, so the activations are in a natural range.
    const n = 224 * 224 * 3, a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.0007) * 0.6 + Math.cos(i * 0.013) * 0.3;
    const x = tf.tensor4d(a, [1, 224, 224, 3]);
    const run = async (u) => {
      const m = await tf.loadLayersModel(u);
      const y = m.predict(x);
      const v = Array.from(await y.data());
      y.dispose(); m.dispose();
      return v;
    };
    const A = await run('/vendor/models/_float32/mobilenet-v1-050/model.json');
    const B = await run('/vendor/models/mobilenet-v1-050-q/model.json');
    x.dispose();
    const top = v => v.map((p, i) => [p, i]).sort((r, s) => s[0] - r[0]).slice(0, 5).map(r => r[1]);
    let maxd = 0; for (let i = 0; i < A.length; i++) maxd = Math.max(maxd, Math.abs(A[i] - B[i]));
    const spread = A.reduce((m, v) => v > m ? v : m, -Infinity) - A.reduce((m, v) => v < m ? v : m, Infinity);
    return { len: A.length, topA: top(A), topB: top(B), maxd: maxd, spread: spread, sumA: A.reduce((s, v) => s + v, 0) };
  });
  ok('SETUP: the reference model produced 1000 class scores', mnet.len === 1000, mnet.len);
  ok('SETUP: the reference output is not flat (a flat one would agree with anything)', mnet.spread > 0.01, +mnet.spread.toFixed(4));
  ok('SETUP: the reference output is a probability distribution', Math.abs(mnet.sumA - 1) < 0.02, +mnet.sumA.toFixed(4));
  ok('the top-1 class is unchanged', mnet.topA[0] === mnet.topB[0], [mnet.topA[0], mnet.topB[0]]);
  ok('the top-5 classes are unchanged', JSON.stringify(mnet.topA) === JSON.stringify(mnet.topB), [mnet.topA, mnet.topB]);
  ok('no class score moved more than 0.02', mnet.maxd < 0.02, +mnet.maxd.toFixed(5));

  console.log('\nDETECTOR  (coco-ssd lite_mobilenet_v2)');
  const COCOB = process.env.COCO_DIR ? '/vendor/models/' + process.env.COCO_DIR + '/model.json' : '/vendor/models/coco-ssd-lite-q/model.json';
  const coco = await page.evaluate(async (COCOB) => {
    const w = 300, h = 300, n = w * h * 3, a = new Int32Array(n);
    for (let i = 0; i < n; i++) a[i] = (Math.floor(128 + 100 * Math.sin(i * 0.0011)) + (i % 7) * 3) & 255;
    const x = tf.tensor(a, [1, h, w, 3], 'int32');
    const run = async (u) => {
      const m = await tf.loadGraphModel(u);
      const out = await m.executeAsync(x);
      const list = Array.isArray(out) ? out : [out];
      const vals = [];
      for (const t of list) { vals.push({ shape: t.shape, v: Array.from(await t.data()) }); t.dispose(); }
      m.dispose();
      return vals;
    };
    const A = await run('/vendor/models/_float32/coco-ssd-lite/model.json');
    const B = await run((COCOB));
    x.dispose();
    // The two output heads are boxes and scores; compare each elementwise,
    // relative to that head's own range so a big head is not flattered.
    const heads = A.map((ha, i) => {
      const hb = B[i]; if (!hb || ha.v.length !== hb.v.length) return { bad: true };
      let maxd = 0, lo = Infinity, hi = -Infinity;
      for (let k = 0; k < ha.v.length; k++) {
        maxd = Math.max(maxd, Math.abs(ha.v[k] - hb.v[k]));
        lo = Math.min(lo, ha.v[k]); hi = Math.max(hi, ha.v[k]);
      }
      return { shape: ha.shape, n: ha.v.length, maxd: maxd, range: hi - lo, rel: (hi - lo) ? maxd / (hi - lo) : 0 };
    });
    // The scores head is the one that decides what is detected at all.
    const mx = v => { let m = -Infinity; for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i]; return m; };
    const scoreHead = A.map((ha, i) => ({ i: i, n: ha.v.length, max: mx(ha.v) }))
      .filter(x => x.max <= 1.001 && x.n > 100).sort((p, q) => q.n - p.n)[0];
    let topAgree = null;
    if (scoreHead) {
      const sa = A[scoreHead.i].v, sb = B[scoreHead.i].v;
      const rank = v => v.map((p, i) => [p, i]).sort((r, s) => s[0] - r[0]).slice(0, 10).map(r => r[1]);
      topAgree = { a: rank(sa), b: rank(sb), maxScoreA: mx(sa) };
    }
    return { heads: heads, topAgree: topAgree };
  }, COCOB);
  ok('SETUP: both models produced the same output heads', coco.heads.every(h => !h.bad), coco.heads.map(h => h.shape));
  ok('SETUP: the reference output varies (a constant one would agree with anything)',
     coco.heads.every(h => h.range > 0.001), coco.heads.map(h => +(h.range || 0).toFixed(4)));
  coco.heads.forEach((h, i) => {
    ok('head ' + i + ' [' + h.shape + '] agrees to within 2% of its own range',
       h.rel < 0.02, { maxd: +h.maxd.toFixed(5), range: +h.range.toFixed(3), rel: +h.rel.toFixed(4) });
  });
  if (coco.topAgree) {
    const same = coco.topAgree.a.filter(i => coco.topAgree.b.indexOf(i) !== -1).length;
    ok('at least 8 of the 10 highest-scoring boxes are the same boxes', same >= 8, { same: same, a: coco.topAgree.a.slice(0, 5), b: coco.topAgree.b.slice(0, 5) });
  }

  console.log('\nSIZE');
  const dirBytes = d => fs.readdirSync(d).reduce((s, f) => s + fs.statSync(path.join(d, f)).size, 0);
  const oldB = dirBytes(path.join(ROOT, 'vendor/models/_float32/coco-ssd-lite')) + dirBytes(path.join(ROOT, 'vendor/models/_float32/mobilenet-v1-050'));
  const newB = dirBytes(path.join(ROOT, 'vendor/models/coco-ssd-lite-q')) + dirBytes(path.join(ROOT, 'vendor/models/mobilenet-v1-050-q'));
  console.log('  ' + (oldB / 1048576).toFixed(1) + ' MB -> ' + (newB / 1048576).toFixed(1) + ' MB');
  // 1.9x, not the 4x uint8 would give. That is the deliberate trade: the
  // assertions above are the reason, and they are what a future "just use
  // uint8, it is smaller" change would have to get past.
  ok('the shipped models are at least 1.8x smaller than float32',
     newB * 1.8 < oldB, { oldMB: +(oldB / 1048576).toFixed(1), newMB: +(newB / 1048576).toFixed(1) });

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
})();
