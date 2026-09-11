/* Sightline smoke test: serves the repo over HTTP, boots it in Chromium with a
   fake camera, and checks the app actually comes up with no page errors. */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = require('path').join(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.json':'application/json', '.svg':'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => server.listen(8712, r));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
           '--autoplay-policy=no-user-gesture-required']
  });
  const ctx = await browser.newContext({
    permissions: ['camera'],
    viewport: { width: 412, height: 892 }
  });
  const page = await ctx.newPage();

  const errors = [], warns = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') warns.push(m.text().slice(0, 160)); });

  const R = [];
  const t = (name, cond, extra) => R.push({ name, pass: !!cond, extra: extra === undefined ? '' : String(extra) });

  await page.goto('http://localhost:8712/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // --- modules present
  const mods = await page.evaluate(() => ['U','SET','WIKI','CAM','TRACK','IDENT','CAPS','UI']
    .map(n => [n, typeof window[n]]));
  mods.forEach(([n, ty]) => t('module ' + n + ' defined', ty === 'object', ty));

  // --- start gate visible before any camera use
  t('start gate visible', await page.isVisible('#gate'));
  t('dock rendered', (await page.$$('.dockbtn')).length >= 5);

  // --- the living-person gate: real Wikidata calls
  const gate = await page.evaluate(async () => {
    const out = {};
    const mozart = await WIKI.person('Wolfgang Amadeus Mozart');
    out.mozart = { ok: mozart.ok, reason: mozart.reason, died: mozart.diedYear };
    const living = await WIKI.person('Serena Williams');
    out.living = { ok: living.ok, name: living.name, jobs: (living.occupations||[]).length, hasUrl: !!living.url };
    const nonsense = await WIKI.person('Qqzzx Nonexistent Person 9182');
    out.nonsense = { ok: nonsense.ok, reason: nonsense.reason };
    return out;
  });
  t('Mozart is refused', gate.mozart.ok === false && gate.mozart.reason === 'deceased', JSON.stringify(gate.mozart));
  t('Mozart death year read', gate.mozart.died && gate.mozart.died < 1800, gate.mozart.died);
  t('a living public figure passes', gate.living.ok === true && !!gate.living.name, JSON.stringify(gate.living));
  t('living figure has a wiki url', gate.living.hasUrl === true);
  t('unknown name is refused', gate.nonsense.ok === false, gate.nonsense.reason);

  // --- taxon lookup
  const tax = await page.evaluate(() => WIKI.taxon('Quercus robur').then(r => r && {
    name: r.name, sci: r.scientific, hasText: (r.extract||'').length > 60
  }));
  t('taxon lookup returns a species', tax && !!tax.name, JSON.stringify(tax));
  t('taxon has a binomial', tax && /Quercus/i.test(tax.sci || tax.name || ''), tax && tax.sci);

  // --- settings round-trip
  const s = await page.evaluate(() => {
    SET.set('conf', 0.9); SET.set('apiBase', 'https://example.workers.dev');
    return { conf: SET.get('conf'), api: SET.hasApi(), url: SET.api('/v1/identify') };
  });
  t('settings persist', s.conf === 0.9);
  t('endpoint detected', s.api === true);
  t('endpoint path joins cleanly', s.url === 'https://example.workers.dev/v1/identify', s.url);

  // --- escaping (a model-supplied name reaches innerHTML)
  const xss = await page.evaluate(() => U.esc('<img src=x onerror=alert(1)>"\''));
  t('html is escaped', xss.indexOf('<') === -1 && xss.indexOf('"') === -1, xss);

  // --- gated person renders an explanation, not a name
  const gatedHtml = await page.evaluate(() => {
    UI.openRecord({ kind:'person', name:'', gated:'deceased', deceasedName:'Wolfgang Amadeus Mozart',
                    diedYear:1791, confidence:0.9 });
    return document.querySelector('#sheetBody').textContent;
  });
  t('deceased match explains itself', /no longer alive/i.test(gatedHtml), gatedHtml.slice(0,80));
  t('deceased match draws no name as a label', !/^Wolfgang/.test(gatedHtml.trim()));

  // --- start the camera for real (fake device)
  await page.click('#btnStart');
  await page.waitForTimeout(3000);
  const started = await page.evaluate(() => ({
    gateHidden: document.querySelector('#gate').classList.contains('hidden'),
    vw: document.querySelector('#cam').videoWidth,
    overlaySized: document.querySelector('#overlay').width > 0
  }));
  t('camera started', started.vw > 0, JSON.stringify(started));
  t('gate dismissed', started.gateHidden === true);
  t('overlay canvas sized', started.overlaySized === true);

  // --- tracking maths, independent of the detector
  const tr = await page.evaluate(() => {
    TRACK.reset();
    const now = performance.now();
    TRACK.update([{ cls:'dog', box:[10,10,100,100], score:.9 }], now);
    const first = TRACK.all()[0].id;
    TRACK.update([{ cls:'dog', box:[14,12,100,100], score:.9 }], now+90);
    const same = TRACK.all()[0].id === first && TRACK.all().length === 1;
    TRACK.update([{ cls:'dog', box:[400,400,60,60], score:.9 }], now+180);
    const split = TRACK.all().length;
    return { same, split, iou: U.iou([0,0,10,10],[5,0,10,10]).toFixed(3) };
  });
  t('a moved object keeps its identity', tr.same === true, JSON.stringify(tr));
  t('a jumped object becomes a new track', tr.split === 2, tr.split);
  t('iou maths correct', tr.iou === '0.333', tr.iou);

  // --- no page errors anywhere
  t('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 300));

  await browser.close();
  server.close();

  const bad = R.filter(r => !r.pass);
  R.forEach(r => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.extra ? '   [' + r.extra + ']' : '')));
  console.log('\n' + (R.length - bad.length) + '/' + R.length + ' passed');
  if (warns.length) console.log('console errors seen: ' + warns.slice(0,4).join(' | ').slice(0,300));
  process.exit(bad.length ? 1 : 0);
})();
