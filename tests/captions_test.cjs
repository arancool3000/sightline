/* Switching captions OFF must remove them.

   The bug: several call sites reach UI.captionDraw after an async gap - a
   translation resolving seconds later, and a recognition result the engine
   flushes AFTER stop() - and that function ends by unhiding the caption bar.
   So captions reappeared moments after being switched off. */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=http.createServer((q,res)=>{
  let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});
  res.end(fs.readFileSync(f));
});

(async()=>{
  await new Promise(r=>server.listen(8781,r));
  const {chromium}=require('playwright');
  const browser=await chromium.launch({args:['--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896},
                                      serviceWorkers:'block'});
  const page=await ctx.newPage();

  /* A controllable stand-in for the speech engine, so the late-result path -
     the one that caused the bug - can be driven deliberately. */
  await page.addInitScript(() => {
    window.__rec = null;
    function Fake() { window.__rec = this; }
    Fake.prototype.start = function () { if (this.onstart) this.onstart(); };
    Fake.prototype.stop  = function () { if (this.onend) this.onend(); };
    Fake.prototype.abort = function () { if (this.onend) this.onend(); };
    Fake.prototype.say = function (text, final) {
      if (!this.onresult) return;
      this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: !!final })] });
    };
    window.SpeechRecognition = Fake;
    window.webkitSpeechRecognition = Fake;
  });

  await page.goto('http://localhost:8781/',{waitUntil:'domcontentloaded'});
  await page.click('#btnStart');
  /* CAM.ready() allows up to 2.5s for video metadata, so a fixed short wait
     leaves the start gate covering the controls and every click is
     intercepted by it rather than being a real fault. */
  await page.waitForFunction(
    () => document.querySelector('#gate').classList.contains('hidden'),
    null, { timeout: 30000 });
  /* Wait for the weights to settle too. Decoding and uploading them blocks
     the main thread hard enough that a click can time out waiting for the
     page to become actionable - which looks like an unclickable button and
     is not one. */
  await page.waitForFunction(
    () => window.LOCAL && (LOCAL.ready() || LOCAL.state().code === 'failed'),
    null, { timeout: 180000 }).catch(()=>{});
  await page.waitForTimeout(500);

  const R=[]; const t=(n,c,x)=>R.push({n,p:!!c,x:x===undefined?'':String(x)});

  /* Hit-testability is asserted explicitly rather than relied on implicitly.
     Playwright's actionability wait kept timing out here even though the
     button is genuinely the top element at its own centre, so the toggles
     below are dispatched directly - but only because THIS has proved a
     finger would reach it. */
  const hit = await page.evaluate(() => {
    const b = document.querySelector('#btnCaptions');
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: top ? (top.id || top.tagName) : 'none', w: Math.round(r.width), h: Math.round(r.height) };
  });
  t('the captions button is the top element at its own centre', hit.top === 'btnCaptions', hit.top);
  t('and it meets the touch floor', hit.w >= 44 && hit.h >= 44, hit.w + 'x' + hit.h);

  const toggle = () => page.evaluate(() => document.querySelector('#btnCaptions').click());
  const vis = () => page.evaluate(() => ({
    hidden: document.querySelector('#captionBar').hidden,
    text: (document.querySelector('#capMain')||{}).textContent || '',
    pressed: document.querySelector('#btnCaptions').getAttribute('aria-pressed')
  }));

  await toggle();
  await page.evaluate(() => window.__rec && window.__rec.say('hello there', true));
  await page.waitForTimeout(400);
  let s = await vis();
  t('captions appear when switched on', s.hidden === false && /hello there/.test(s.text), s.text);
  t('the button reads as on', s.pressed === 'true', s.pressed);

  /* ---- OFF ---- */
  await toggle();
  await page.waitForTimeout(200);
  s = await vis();
  t('switching off HIDES the caption bar', s.hidden === true, 'hidden=' + s.hidden);
  t('switching off CLEARS the text', s.text.trim() === '', JSON.stringify(s.text));
  t('the button reads as off', s.pressed === 'false', s.pressed);

  /* ---- the actual bug: work arriving AFTER the user switched off ---- */
  await page.evaluate(() => window.__rec && window.__rec.say('late interim words', false));
  await page.waitForTimeout(300);
  s = await vis();
  t('a LATE interim result does not reopen captions', s.hidden === true, 'hidden=' + s.hidden);

  await page.evaluate(() => window.__rec && window.__rec.say('late final words', true));
  await page.waitForTimeout(300);
  s = await vis();
  t('a LATE final result does not reopen captions', s.hidden === true, 'hidden=' + s.hidden);
  t('and no late text leaked onto the screen', !/late/.test(s.text), JSON.stringify(s.text));

  /* a translation resolving long after the user switched off */
  await page.waitForTimeout(2500);
  s = await vis();
  t('still hidden after any pending translation would have resolved', s.hidden === true, 'hidden=' + s.hidden);

  /* ---- CONTROL: it must still work when switched back on ---- */
  await toggle();
  await page.evaluate(() => window.__rec && window.__rec.say('back again', true));
  await page.waitForTimeout(400);
  s = await vis();
  t('CONTROL - captions still work when switched back on',
    s.hidden === false && /back again/.test(s.text), s.text);

  /* ---- EVERY LINE GETS TRANSLATED, BY GEMINI ----

     "it should use gemini to translate(3.5). all captions must be
      translated." It used to go to MyMemory through the Worker, and -
     the part that actually bit - it gave up entirely when no Worker
     endpoint was set, showing the caption in the language it was spoken
     in, which is the one thing captions are for. */
  const tr = await page.evaluate(async () => {
    /* ⚠ Stub the NETWORK, not GEM.ask: translate() calls the module's own
       `ask`, not the exported property, so replacing GEM.ask intercepts
       nothing and the first cut of this test measured the fallback. */
    /* ⚠ Set a real key rather than stubbing GEM.has: translate() calls the
       module's own has(), not the exported property, so the first two cuts
       of this test both measured the fallback instead. */
    const realFetch = U.fetchT, realPost = IDENT.post, realKey = SET.get('geminiKey');
    let asked = null, workerCalls = 0;
    IDENT.post = () => { workerCalls++; return Promise.resolve({ ok: true, text: 'FROM THE WORKER' }); };
    SET.set('geminiKey', 'AIzaTESTTESTTESTTESTTESTTEST');
    U.fetchT = (u, o) => {
      try { asked = JSON.parse(o.body).contents[0].parts[0].text; } catch (e) {}
      return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(
        { candidates: [{ content: { parts: [{ text: 'the bus is late' }] } }] })) });
    };

    SET.set('capTo', 'en'); SET.set('capFrom', 'fr');
    window.__rec.say('le bus est en retard', true);
    await new Promise(r => setTimeout(r, 700));
    const withKey = (document.getElementById('capMain') || {}).textContent || '';

    /* Counted HERE: the no-key line below calls the Worker on purpose, so
       reading the total at the end says nothing about the key path. */
    const workerAfterKey = workerCalls;

    /* No key at all: the Worker is the fallback, not silence. */
    SET.set('geminiKey', '');
    window.__rec.say('il pleut beaucoup', true);
    await new Promise(r => setTimeout(r, 700));
    const noKey = (document.getElementById('capMain') || {}).textContent || '';

    SET.set('geminiKey', realKey || ''); U.fetchT = realFetch; IDENT.post = realPost;
    return { withKey, noKey, asked: asked || '', workerCalls, workerAfterKey };
  });
  t('a caption is translated by Gemini', /the bus is late/.test(tr.withKey), tr.withKey);
  t('and the Worker is not asked when the key answered', tr.workerAfterKey === 0, tr.workerAfterKey);
  t('the prompt says the target language and forbids commentary',
    /into en/.test(tr.asked) && /NOTHING else/.test(tr.asked), tr.asked.slice(0, 70));
  t('CONTROL - with no key it falls back rather than showing the original',
    /FROM THE WORKER/.test(tr.noKey), tr.noKey);

  await browser.close(); server.close();
  const bad=R.filter(x=>!x.p);
  R.forEach(x=>console.log((x.p?'PASS  ':'FAIL  ')+x.n+(x.x?'   ['+x.x+']':'')));
  console.log('\n'+(R.length-bad.length)+'/'+R.length+' passed');
  process.exit(bad.length?1:0);
})();
