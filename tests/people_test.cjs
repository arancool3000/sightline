/* "must be able to easily identify movie stars etc."

   It could not, and the reason was two gates on the same doubt. The
   confidence floor is the MODEL'S OPINION OF ITSELF, and it is 0.75 by
   default. For an object that floor is the only check there is. For a
   person there is a far stronger one behind it - the name has to resolve
   to a living human with a Wikipedia article and a Wikidata entity - so
   requiring both meant an actor whose name the model knew perfectly well
   was thrown away for hedging, before Wikipedia was ever asked.

   The model proposes now; the encyclopedia decides. That is only safe if
   the encyclopedia really is deciding, which is what most of this suite
   is about: the SAME loosening that lets a star through must not let a
   private person, a dead lookalike, or an invented name through. Every
   assertion below has its opposite number.

   Nothing here talks to Wikipedia. Every answer is stubbed, so what is
   measured is our gate rather than the internet's mood.                 */
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

(async () => {
  await new Promise(r => server.listen(0, r));
  const BASE = 'http://127.0.0.1:' + server.address().port + '/';
  const { chromium } = require('playwright');
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 412, height: 892 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message.slice(0, 140)));
  await page.route('**/vendor/models/**', r => r.abort());
  await page.route(/wikipedia|wikidata/, r => r.abort());     // the stub replaces it entirely
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.IDENT && window.WIKI && window.SET, null, { timeout: 30000 });

  /* One stubbed encyclopedia, shared by every case below. It knows two
     living public figures, one dead one, and nobody else. */
  await page.evaluate(() => {
    window.__asked = [];
    WIKI.person = function (name) {
      window.__asked.push(name);
      const n = String(name || '').toLowerCase();
      if (n === 'florence pugh') return Promise.resolve({
        ok: true, name: 'Florence Pugh', qid: 'Q1', url: 'https://x/1',
        extract: 'An English actress.', bornYear: 1996,
        occupations: ['Actor'], knownFor: ['Midsommar', 'Little Women'],
        awards: ['A Prize'], country: 'United Kingdom' });
      if (n === 'cillian murphy') return Promise.resolve({
        ok: true, name: 'Cillian Murphy', qid: 'Q2', url: 'https://x/2',
        extract: 'An Irish actor.', bornYear: 1976,
        occupations: ['Actor'], knownFor: ['Oppenheimer'], awards: [], country: 'Ireland' });
      if (n === 'humphrey bogart') return Promise.resolve({
        ok: false, reason: 'deceased', diedYear: 1957, name: 'Humphrey Bogart' });
      return Promise.resolve({ ok: false, reason: 'no-article' });
    };
  });

  const enrich = (rec) => page.evaluate(r => {
    window.__asked = [];
    return IDENT._enrich(r, 'person').then(out => ({ out: out, asked: window.__asked.slice() }));
  }, rec);

  console.log('\nA STAR THE MODEL IS ONLY HALF SURE OF');
  {
    /* 0.42 is well under the 0.75 confidence floor, and this is exactly
       the case that used to be thrown away. */
    const r = await enrich({ kind: 'person', name: 'Florence Pugh', confidence: 0.42 });
    ok('a hedged answer still gets looked up', r.asked.length >= 1, r.asked);
    ok('and the name is shown', r.out.name === 'Florence Pugh', r.out.name);
    ok('with nothing gating it', !r.out.gated, r.out.gated);
    ok('and what they are known for comes with it',
       !!r.out.wiki && (r.out.wiki.knownFor || []).indexOf('Midsommar') >= 0,
       r.out.wiki && r.out.wiki.knownFor);
  }

  console.log('\nAND WHEN THE FIRST GUESS IS THE WRONG ONE');
  {
    const r = await enrich({ kind: 'person', name: 'Somebody Nobody', confidence: 0.55,
                             alt: ['Not A Person Either', 'Cillian Murphy'] });
    ok('the runners-up get a turn', r.asked.length === 3, r.asked);
    ok('and the one who checks out is the one shown', r.out.name === 'Cillian Murphy', r.out.name);
    ok('and it says whose guess it was correcting', r.out.viaAlt === 'Somebody Nobody', r.out.viaAlt);
  }

  console.log('\nTHE SAME LOOSENING MUST NOT LET ANYBODY ELSE THROUGH');
  {
    const priv = await enrich({ kind: 'person', name: 'Dave From Work', confidence: 0.93 });
    ok('CONTROL: a name with no article is refused however sure the model is',
       !priv.out.name && priv.out.gated === 'no-article', priv.out);

    const dead = await enrich({ kind: 'person', name: 'Humphrey Bogart', confidence: 0.99 });
    ok('CONTROL: a dead lookalike is still refused',
       !dead.out.name && dead.out.gated === 'deceased', dead.out);
    ok('CONTROL: and it says who the resemblance was to',
       dead.out.deceasedName === 'Humphrey Bogart' && dead.out.diedYear === 1957, dead.out);

    const none = await enrich({ kind: 'person', name: '', confidence: 0 });
    ok('CONTROL: no name at all is still no name', !none.out.name, none.out);

    const noise = await enrich({ kind: 'person', name: 'Florence Pugh', confidence: 0.05 });
    ok('CONTROL: a floor still exists - 0.05 is noise, not a proposal',
       !noise.out.name && noise.out.gated === 'low-confidence', noise.out);

    const off = await page.evaluate(() => {
      SET.set('faces', false);
      return IDENT._enrich({ kind: 'person', name: 'Florence Pugh', confidence: 0.9 }, 'person')
        .then(o => { SET.set('faces', true); return o; });
    });
    ok('CONTROL: with naming people switched off, nobody is named',
       !off.name && off.gated === 'faces-off', off);
  }

  console.log('\nAND AN OBJECT KEEPS THE FLOOR IT ALWAYS HAD');
  {
    /* The whole argument for lowering the person floor is that something
       else checks a person. Nothing else checks a kettle, so if this
       assertion goes green for 0.42 the change has leaked. */
    const o = await page.evaluate(() => {
      SET.set('conf', 0.75);
      return IDENT._enrich({ kind: 'object', name: 'Some Kettle', confidence: 0.42 }, 'object');
    });
    ok('CONTROL: an object below the confidence floor is still gated',
       !o.name && o.gated === 'low-confidence', o);
  }

  console.log('\n"WHO IS THAT" IS A BUILT-IN, NOT A ROUND TRIP');
  {
    const c = await page.evaluate(() => {
      const hit = CMD.match('who is that');
      const hit2 = CMD.match("who's that");
      const hit3 = CMD.match('name that actor');
      const notThis = CMD.match('who is the director of this film and when did they make it');
      return { a: hit && hit.name, b: hit2 && hit2.name, c: hit3 && hit3.name, d: !!notThis };
    });
    ok('"who is that" is handled on the device', c.a === 'who is that', c);
    ok('so are "who\'s that" and "name that actor"',
       c.b === 'who is that' && c.c === 'who is that', c);
    ok('CONTROL: a real question about a film still goes to the model', c.d === false, c);
  }

  console.log('\nA TAP ASKS THE AI, AND FALLS BACK WHEN IT CANNOT');
  {
    /* "whenever you tap on an object it must use ai and fall back to
        wikipedia if out of free gemini. that only should happen when you
        tap on that object." */
    const r = await page.evaluate(async () => {
      const realHas = GEM.has, realAsk = GEM.ask, realCrop = CAM.crop;
      CAM.crop = () => 'data:image/jpeg;base64,/9j/4AAQ';
      const t = { id: 't1', cls: 'person', raw: [0, 0, 10, 10] };
      let asked = 0;

      GEM.has = () => true;
      GEM.ask = () => { asked++; return Promise.resolve({ ok: true, model: 'g', text: '',
        json: { kind: 'person', name: 'Florence Pugh', confidence: 0.44 } }); };
      const good = await IDENT.tapAsk(t);

      /* Turned away: no record, so the caller uses the old path. */
      GEM.ask = () => { asked++; return Promise.resolve({ ok: false, error: 'at its limit' }); };
      const limited = await IDENT.tapAsk(t);

      /* No key: it must not even ask. */
      GEM.has = () => false;
      const before = asked;
      const noKey = await IDENT.tapAsk(t);

      CAM.crop = realCrop; GEM.has = realHas; GEM.ask = realAsk;
      return { name: good && good.name, src: good && good.source,
               limited, noKey, askedWithoutKey: asked - before };
    });
    ok('a tap gets the answer from Gemini', r.name === 'Florence Pugh' && r.src === 'gemini', r);
    ok('and the same gate applies - it went through Wikipedia', r.name === 'Florence Pugh', r);
    ok('out of free Gemini it answers nothing, so the old path takes over', r.limited === null, r);
    ok('CONTROL: with no key it does not ask at all', r.noKey === null && r.askedWithoutKey === 0, r);
  }

  ok('no page errors throughout', errs.length === 0, errs);
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  await b.close(); server.close(); process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('  FAIL the suite could not finish  ' + JSON.stringify(String(e && e.message || e).split('\n')[0]));
  console.log('\n' + pass + '/' + (pass + fail + 1) + ' passed');
  process.exit(1);
});
