/* Proves the two models load INDEPENDENTLY.
   The bug this pins: LOCAL.load() used to sit inside the detector's .then(),
   so one failed detector fetch also stopped the classifier - and the
   classifier is the realtime path the whole app depends on. */
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
  await new Promise(r=>server.listen(8731,r));
  const {chromium}=require('playwright');
  const browser=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
  const page=await ctx.newPage();
  const errs=[]; let weightsRequested=false, navigations=0;
  page.on('pageerror',e=>errs.push(e.message.slice(0,120)));
  page.on('request',r=>{ if(/mobilenet|model\.json/.test(r.url())) weightsRequested=true; });
  page.on('framenavigated',f=>{ if(f===page.mainFrame()) navigations++; });

  /* Both model loaders are stubbed BEFORE any script runs: the detector
     always fails, the classifier always succeeds. Whether the classifier is
     even asked is the whole question. */
  await page.addInitScript(() => {
    window.__calls = { detector: 0, classifier: 0 };
    Object.defineProperty(window, 'cocoSsd', {
      configurable: true,
      get() { return { load: () => { window.__calls.detector++; return Promise.reject(new Error('simulated network failure')); } }; }
    });
    Object.defineProperty(window, 'mobilenet', {
      configurable: true,
      get() {
        return { load: () => { window.__calls.classifier++;
          return Promise.resolve({ classify: () => Promise.resolve([{className:'golden retriever',probability:0.9}]) }); } };
      }
    });
  });

  await page.goto('http://localhost:8731/',{waitUntil:'domcontentloaded'});
  await page.click('#btnStart');
  await page.waitForFunction(()=>window.LOCAL&&LOCAL.ready(),null,{timeout:90000}).catch(()=>{});
  await page.waitForTimeout(1200);

  const R=[]; const t=(n,c,x)=>R.push({n,p:!!c,x:x===undefined?'':String(x)});
  const r = await page.evaluate(() => ({
    calls: window.__calls,
    diag: window.SL_DIAG(),
    ready: LOCAL.ready(),
    sceneShown: !document.querySelector('#sceneChip').hidden
  }));

  /* A FIXED SLEEP IS A PIN ON A TIMING. The scene pass is paced, so 1200ms
     after the classifier reports ready is not long enough for one to have
     run, and this read false for a build that was working. Poll, and say
     how long it took. */
  let sceneMs = -1;
  try {
    const t0 = Date.now();
    await page.waitForFunction(() => {
      const c = document.querySelector('#sceneChip');
      return c && !c.hidden && (document.querySelector('#sceneName')||{}).textContent;
    }, null, { timeout: 25000 });
    sceneMs = Date.now() - t0;
  } catch (e) { /* left at -1: nothing was ever put on the screen */ }
  const scene = await page.evaluate(() => ({
    shown: !document.querySelector('#sceneChip').hidden,
    name: (document.querySelector('#sceneName')||{}).textContent || '',
    kind: (document.querySelector('#sceneKind')||{}).textContent || ''
  }));

  t('the detector was attempted', r.calls.detector >= 1, r.calls.detector);
  /* Pin the PROPERTY, not the loader. Counting mobilenet.load() calls broke
     the moment the classifier started loading vendored weights directly -
     a change that made it more reliable, not less. What matters is that the
     classifier was still fetched and started while the detector was failing. */
  t('THE CLASSIFIER WAS STILL ATTEMPTED after the detector failed',
    weightsRequested || r.calls.classifier >= 1,
    weightsRequested ? 'weights fetched' : ('mobilenet.load x' + r.calls.classifier));
  t('the classifier is ready despite the detector failing', r.ready === true, r.ready);
  t('diagnostics report the detector as failed', /failed/.test(r.diag.detector), r.diag.detector);
  t('diagnostics report the classifier as ok', r.diag.classifier === 'ok', r.diag.classifier);
  /* The property is that losing the detector does not leave the screen
     blank - the classifier carries on and the reader is given something to
     act on. Which of the two it is depends on what the fake camera is
     pointed at, and pinning that would be pinning the stub. */
  t('the screen is not left blank when the detector fails',
    scene.shown === true, JSON.stringify({ ...scene, waitedMs: sceneMs }));
  /* And the half the polled line CANNOT settle: when the reading is weak,
     the readout must offer a way to identify rather than go blank. The
     species model also writes this chip, so waiting for the camera to
     produce a weak reading proves nothing - it is driven directly.

     (Found by planting: removing the offer left the polled line green,
     because the species pass had put a name up in the meantime.) */
  const weak = await page.evaluate(() => {
    document.querySelectorAll('.arCard').forEach(el => el.remove());
    UI.sceneLabel({ name: 'spaghetti squash', score: 0.31, margin: 0.04, kind: 'object' });
    const c = document.querySelector('#sceneChip');
    return { shown: c && !c.hidden,
             name: (document.querySelector('#sceneName')||{}).textContent || '',
             kind: (document.querySelector('#sceneKind')||{}).textContent || '' };
  });
  t('a reading it is not sure of offers to identify, it does not go blank',
    weak.shown === true && weak.name.length > 0, JSON.stringify(weak));
  /* NOT "the guess is hidden" - that was the over-correction the owner
     called "underconfident, under labelled". The guess may be shown; what
     it may not do is sound certain. So it must carry the mark, or the
     second line must say it is not sure. A build that writes the bare noun
     fails this; a build that says nothing fails the line above. */
  t('and a weak guess is marked as one rather than stated as a fact',
    /\?/.test(weak.name) || /not sure|possibly|still looking/i.test(weak.kind),
    JSON.stringify(weak));
  /* CONTROLS - these pass either way and stop the fix over-reaching. */
  /* The service-worker self-heal must refresh an UPDATED build, never a first
     visit. Reloading every new visitor once is a real cost and it destroyed
     the recogniser suite's page mid-test. */
  t('a first visit is not reloaded by the service worker', navigations <= 1, navigations + ' navigation(s)');
  t('CONTROL - the page did not throw', errs.length === 0, errs.join('|').slice(0,120));
  t('CONTROL - libs are served same-origin', await page.evaluate(() =>
      [...document.scripts].every(s => !s.src || s.src.startsWith(location.origin))), '');

  /* ---- the offline shell has to name every script the page loads ----

     It had drifted to ten of the twenty-five modules. A missing one still
     worked, because a cache miss is fetched and then stored - but only
     after one online visit, so a first run that lost signal part way
     through came up broken. The list is DERIVED from index.html here,
     because a hand-kept copy of "what the app is made of" is the thing
     that drifted in the first place. */
  const shellCheck = await page.evaluate(async () => {
    const html = await fetch('index.html').then(r => r.text());
    const sw   = await fetch('sw.js').then(r => r.text());
    const wanted = (html.match(/src="((?:js|vendor)\/[a-z0-9._-]+\.js)"/g) || [])
      .map(s2 => s2.slice(5, -1));
    const missing = wanted.filter(f => sw.indexOf("'./" + f + "'") < 0);
    return { wanted: wanted.length, missing: missing };
  });
  t('SETUP: the page really does load a pile of scripts', shellCheck.wanted >= 20, shellCheck.wanted);
  t('the offline shell names every one of them',
    shellCheck.missing.length === 0, shellCheck.missing);

  await browser.close(); server.close();
  const bad=R.filter(x=>!x.p);
  R.forEach(x=>console.log((x.p?'PASS  ':'FAIL  ')+x.n+(x.x?'   ['+x.x+']':'')));
  console.log('\n'+(R.length-bad.length)+'/'+R.length+' passed');
  process.exit(bad.length?1:0);
})();
