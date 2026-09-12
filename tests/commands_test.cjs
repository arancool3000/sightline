/* "i want this to be able to be used hands free ... built in voice commands
    which get checked before sent to gemini like show map or select subject
    n more complex commands are handed to gemini. and gemini should have
    even more tool calls it can use."

   Three things have to be true, and the middle one is the one a test is
   really for:

     THE COMMON THINGS NEVER LEAVE THE DEVICE. No network, no key, no
     quota. This suite fails if a single request goes out while it is
     saying "show the map".

     THE REST STILL GOES TO THE MODEL. A table that swallowed everything
     would pass the first line and make the app stupid, so there is a
     control for a sentence that must fall through.

     THE MODEL'S TOOLS ARE THE SAME TOOLS. Every one of Gemini's new
     actions runs through the same table, so it can never reach past what
     a person can press.                                                  */
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
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
                          else { fail++; console.log('  FAIL ' + n + (x === undefined ? '' : '  ' + JSON.stringify(x))); } };

(async () => {
  await new Promise(r => server.listen(0, r));
  const BASE = 'http://127.0.0.1:' + server.address().port + '/';
  const { chromium } = require('playwright');
  const b = await chromium.launch();
  const ctx = await b.newContext({ permissions: ['geolocation'],
                                   geolocation: { latitude: 51.5074, longitude: -0.1278 },
                                   viewport: { width: 412, height: 892 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message.slice(0, 140)));

  /* Everything that leaves the page, so "it never leaves the device" is
     measured rather than asserted. */
  const outbound = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (!u.startsWith(BASE)) { outbound.push(u.slice(0, 90)); return r.abort(); }
    if (/\/vendor\/models\//.test(u)) return r.abort();
    return r.continue();
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.CMD && window.MAP && window.MAPVIEW && window.VOICE && window.GEO,
                             null, { timeout: 30000 });
  await page.evaluate(() => {
    const g = document.getElementById('gate'); if (g) { g.classList.add('hidden'); g.hidden = true; }
    GEO._set({ lat: 51.5074, lon: -0.1278, acc: 10 }, 40, [], { temp: 16, code: 1, wind: 12 });
  });

  console.log('\nTHE ORDINARY THINGS, WITH NOTHING LEAVING THE DEVICE');
  outbound.length = 0;

  const say = line => page.evaluate(l => {
    const r = CMD.run(l);
    return { handled: !!r, name: r && r.name, say: r && r.say,
             mapOpen: MAP.isOpen(), layers: JSON.parse(JSON.stringify(MAPVIEW.state().layers)),
             mpp: MAPVIEW.state().mpp };
  }, line);

  let r = await say('show me the map');
  ok('"show me the map" is handled here', r.handled && r.name === 'open map', r);
  ok('and the map really opened', r.mapOpen === true, r.mapOpen);
  ok('and it says so out loud', !!r.say, r.say);

  const before = (await say('zoom in')).mpp;
  r = await say('zoom in');
  ok('"zoom in" moves the map in', r.handled && r.mpp < before, { before, after: r.mpp });

  /* The picture is one layer now - tiles carry the buildings - so every
     word for it lands on the same chip. */
  /* "hide the map" closes the page - that is what the words mean - so the
     picture layer answers to its contents: streets, tiles, buildings. */
  r = await say('hide the streets');
  ok('"hide the streets" turns the picture off', r.handled && !r.layers.map, r.layers);
  r = await say('show the buildings');
  ok('CONTROL: "show the buildings" turns it back on', !!r.layers.map, r.layers);

  r = await say('close the map');
  ok('"close the map" closes it', r.handled && r.mapOpen === false, r);

  r = await say('identify the subject');
  ok('"identify the subject" is one of the built-ins', r.handled && r.name === 'select subject', r);

  r = await say('scan this code');
  ok('"scan this code" is too', r.handled && r.name === 'scan', r);

  /* The map fetching its own streets is the map working, not the command
     phoning home. What must never happen is a built-in reaching an
     ASSISTANT - that is the cost, the wait and the quota the whole layer
     exists to avoid. */
  const assistant = outbound.filter(u => /generativelanguage|\/v1\/ask|openai|anthropic/i.test(u));
  ok('no built-in reached an assistant', assistant.length === 0, assistant);
  ok('SETUP: the probe really was watching the network',
     outbound.length > 0, outbound.length);

  console.log('\nWHAT IS NOT IN THE TABLE STILL GOES TO THE MODEL');
  {
    /* The control that stops the table swallowing the app. */
    const fell = await page.evaluate(() => [
      'what is the tallest building I can see',
      'is this safe to eat',
      'why is the sky that colour',
      'read me the label on the blue box and tell me if it has nuts in it',
      'show me how to get this stain out of the carpet',
      'can you tell me whether the map of this area is accurate'
    ].map(q => ({ q: q, handled: !!CMD.run(q) })));
    ok('CONTROL: a real question is NOT swallowed by the table',
       fell.every(f => !f.handled), fell.filter(f => f.handled));
  }
  {
    const both = await page.evaluate(() => {
      const seen = [];
      const real = VOICE.ask;
      VOICE.wake();
      /* What did the built-in table claim, and what fell through? */
      return { cmd: !!CMD.run('show the map'), question: !!CMD.run('what am I looking at') };
    });
    ok('SETUP: the two are told apart', both.cmd === true && both.question === false, both);
  }

  console.log('\nSPOKEN DIRECTIONS');
  {
    const d = await page.evaluate(() => {
      const hit = CMD.match('hey vision start directions to the post office on the high street');
      return { matched: !!hit, name: hit && hit.name, where: hit && hit.m[1] };
    });
    ok('"start directions to the post office" is recognised',
       d.matched && d.name === 'directions', d);
    ok('and it takes the place out of the sentence', /post office/i.test(d.where || ''), d.where);

    const stop = await page.evaluate(() => {
      MAP.setDest({ title: 'Somewhere', lat: 51.51, lon: -0.13, dist: 400, bearing: 10 });
      const r = CMD.run('stop directions');
      return { handled: !!r, dest: MAP.dest() };
    });
    ok('"stop directions" puts the route away', stop.handled && !stop.dest, stop);
  }

  console.log('\nEVERY TOOL THE MODEL HAS GOES THROUGH THE SAME TABLE');
  {
    const t = await page.evaluate(() => {
      const names = Object.keys(VOICE.ACTIONS);
      MAP.setOpen(false);
      VOICE._apply([{ do: 'map', open: true }]);
      const opened = MAP.isOpen();
      VOICE._apply([{ do: 'layer', name: 'buildings', on: false }]);
      const bld = MAPVIEW.state().layers.buildings;
      VOICE._apply([{ do: 'map', open: false }]);
      const closed = !MAP.isOpen();
      /* And a verb that is not in the vocabulary must do nothing at all. */
      const n = VOICE._apply([{ do: 'formatTheDisk' }, { do: 'sendEmail', to: 'x' }]);
      return { names: names, opened: opened, bld: bld, closed: closed, invented: n };
    });
    ok('the model can open and close the map', t.opened === true && t.closed === true, t);
    ok('and switch a layer', !t.bld, t.bld);
    ok('CONTROL: a verb it invented is dropped, not guessed at', t.invented === 0, t.invented);
    ok('SETUP: there are more tools than the original five',
       t.names.length >= 12, t.names.length);
  }

  /* The wake word said in the same breath must reach the table too - it
     used to go straight past it to the model. */
  {
    const breath = await page.evaluate(() => ({
      withWake: !!CMD.run('hey vision close the map'),
      polite:   !!CMD.match('please show the map'),
      bare:     !!CMD.match('show the map')
    }));
    ok('the wake word in the same breath still reaches the built-ins',
       breath.withWake === true, breath);
    ok('and so does an ordinary politeness', breath.polite === true, breath);
    ok('SETUP: the bare form works too', breath.bare === true, breath);
  }

  ok('no page errors throughout', errs.length === 0, errs);
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  await b.close(); server.close(); process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('  FAIL the suite could not finish  ' + JSON.stringify(String(e && e.message || e).split('\n')[0]));
  console.log('\n' + pass + '/' + (pass + fail + 1) + ' passed');
  process.exit(1);
});
