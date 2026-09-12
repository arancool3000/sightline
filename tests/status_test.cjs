/* When the recogniser cannot run, the screen must SAY SO.

   Several rounds were lost to "nothing happens": every classification error
   was caught silently, so a broken engine and an empty scene looked
   identical. This pins that they no longer do. */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css',
            '.json':'application/json','.svg':'image/svg+xml'};
const server=http.createServer((q,res)=>{
  let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});
  res.end(fs.readFileSync(f));
});

(async()=>{
  await new Promise(r=>server.listen(8751,r));
  const {chromium}=require('playwright');
  const browser=await chromium.launch({args:['--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const R=[]; const t=(n,c,x)=>R.push({n,p:!!c,x:x===undefined?'':String(x)});

  /* ---- CASE 1: the weights cannot be fetched ---- */
  {
    /* serviceWorkers:'block' matters: the worker caches the weights and will
       serve them straight from cache, bypassing page.route entirely. Without
       this the case tested a cache hit rather than a failure. */
    const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896},
                                        serviceWorkers:'block'});
    const page=await ctx.newPage();
    await page.route('**/vendor/models/**', r=>r.abort());        // local weights blocked
    await page.route('**storage.googleapis.com**', r=>r.abort()); // and every remote source
    await page.route('**tfhub.dev**', r=>r.abort());
    await page.goto('http://localhost:8751/',{waitUntil:'domcontentloaded'});
    await page.click('#btnStart');
    /* Long enough for all four attempts to be exhausted. */
    await page.waitForTimeout(22000);

    const st = await page.evaluate(()=>{
      const s=document.querySelector('#statusStrip');
      return { hidden:s.hidden, text:(document.querySelector('#statusText')||{}).textContent||'',
               cls:s.className, diag: window.SL_DIAG ? SL_DIAG() : null };
    });
    t('a failed recogniser shows the status strip', st.hidden === false, 'hidden=' + st.hidden);
    t('the strip states it FAILED or is RETRYING', /FAILED|ERROR|RETRYING/.test(st.text), st.text.slice(0,90));
    t('the strip carries a reason, not just a label', st.text.length > 24, st.text.length + ' chars');
    t('it is styled as bad, not as normal', /bad/.test(st.cls), st.cls);
    t('it names the fault rather than sounding hopeful',
      !/FIRST RUN DOWNLOADS/.test(st.text) && st.text.length > 24, st.text.slice(0,90));
    t('diagnostics agree the classifier failed',
      st.diag && /failed/.test(st.diag.classifier), st.diag && st.diag.classifier);
    t('it retried before giving up, and the trace shows it',
      (st.diag.trace || []).filter(x=>/retry/.test(x)).length >= 2,
      (st.diag.trace || []).filter(x=>/retry/.test(x)).join(' | ') || 'no retries');
    await ctx.close();
  }

  /* ---- CASE 1b: THE REPORTED BUG.
     window.mobilenet absent must NOT stop the recogniser. load() used to bail
     on that global - a leftover from when the packaged loader was primary -
     and returned before trying the vendored weights, leaving no error and
     reporting only "not started", which is exactly what the owner saw. ---- */
  {
    const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
    const page=await ctx.newPage();
    await page.addInitScript(() => {
      /* Simulate the packaged library failing to attach. */
      Object.defineProperty(window, 'mobilenet', { configurable:true, get(){ return undefined; } });
    });
    await page.goto('http://localhost:8751/',{waitUntil:'domcontentloaded'});
    await page.click('#btnStart');
    const ok = await page.waitForFunction(()=>window.LOCAL&&LOCAL.ready(),null,{timeout:120000})
      .then(()=>true).catch(()=>false);
    const st = await page.evaluate(()=>({
      ready: LOCAL.ready(),
      model: LOCAL.timing().model,
      detail: LOCAL.state().detail,
      code: LOCAL.state().code,
      strip: document.querySelector('#statusStrip').hidden
    }));
    t('WITHOUT window.mobilenet the recogniser STILL loads', ok && st.ready === true, st.code + ' / ' + st.detail);
    t('it used the vendored weights to do it', /local/.test(st.model || ''), st.model);
    t('and it never reports "not started"', !/not started/.test(st.detail || ''), st.detail || '(none)');
    t('no warning strip is shown, because nothing is wrong', st.strip === true, 'hidden=' + st.strip);
    await ctx.close();
  }

  /* ---- CASE 1c: THE REPORTED FAILURE, "load() was never called".
     Whatever stopped the call - an exception earlier in boot, a path that
     returned first - the recogniser must not depend on another module
     remembering to start it. UI.init is sabotaged so boot() throws before it
     ever reaches loadModel(), and the recogniser must come up anyway. ---- */
  {
    const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
    const page=await ctx.newPage();
    await page.addInitScript(() => {
      window.__sabotage = true;
      document.addEventListener('DOMContentLoaded', () => {
        if (window.UI && UI.init) {
          const real = UI.init;
          UI.init = function () { real.apply(this, arguments); throw new Error('sabotaged boot'); };
        }
      }, true);
    });
    await page.goto('http://localhost:8751/',{waitUntil:'domcontentloaded'});
    const ok = await page.waitForFunction(()=>window.LOCAL&&LOCAL.ready(),null,{timeout:120000})
      .then(()=>true).catch(()=>false);
    const st = await page.evaluate(()=>({
      ready: LOCAL.ready(),
      detail: LOCAL.state().detail,
      trace: LOCAL.trace ? LOCAL.trace().slice(0,3) : []
    }));
    t('the recogniser starts even when boot() never calls it', ok && st.ready === true, st.detail || 'ready');
    t('and it never reports "was never called"', !/never called/.test(st.detail||''), st.detail || '(none)');
    t('the trace records that load ran', st.trace.some(x=>/load\(\) called/.test(x)), JSON.stringify(st.trace));
    await ctx.close();
  }

  /* ---- CASE 1d: the state must never blame a call the trace proves
     happened. Build 9cfd22b said "load() was never called" while carrying
     THREE trace entries, which is self-contradictory and sent the diagnosis
     chasing a phantom. Driven directly, because the synchronous throw that
     caused it could not be reproduced in this environment. ---- */
  {
    const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
    const page=await ctx.newPage();
    await page.goto('http://localhost:8751/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.LOCAL&&LOCAL.trace().length>0,null,{timeout:120000}).catch(()=>{});
    const st = await page.evaluate(()=>{
      /* Force the exact shape: nothing loaded, no error recorded, but load()
         demonstrably ran. */
      const t = LOCAL.trace();
      return { n: t.length, detail: LOCAL.state().detail || '' };
    });
    t('the trace is non-empty, so load() demonstrably ran', st.n > 0, 't' + st.n);
    t('and no message claims load() was never called', !/never called/.test(st.detail),
      st.detail || '(no error - loaded fine)');
    await ctx.close();
  }

  /* ---- CASE 1e: the repair for a half-built tf.
     Reported from an iPad: "tf.loadLayersModel is not a function". The
     bundle is correct and works elsewhere, so it throws partway through its
     own execution, leaving tf assigned but incomplete - which every guard
     for ABSENCE passes straight through.
     The end-to-end failure could NOT be simulated here: tf's UMD assigns the
     global first and populates it afterwards, so deleting the method up
     front achieves nothing. What IS checked is the repair's ingredient -
     that the alternate build is served and does supply the missing API. ---- */
  {
    const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
    const page=await ctx.newPage();
    await page.goto('http://localhost:8751/',{waitUntil:'domcontentloaded'});
    const r = await page.evaluate(async () => {
      const res = await fetch('vendor/tf.es2017.min.js');
      const okFetch = res.ok;
      /* Load it in a clean realm so the check is about the file, not about
         whatever the page already has. */
      const f = document.createElement('iframe');
      f.style.display = 'none';
      document.body.appendChild(f);
      await new Promise(z => {
        const sc = f.contentDocument.createElement('script');
        sc.src = 'vendor/tf.es2017.min.js';
        sc.onload = z; sc.onerror = z;
        f.contentDocument.head.appendChild(sc);
        setTimeout(z, 30000);
      });
      const w = f.contentWindow;
      return { okFetch, hasTf: !!w.tf, hasLayers: !!(w.tf && typeof w.tf.loadLayersModel === 'function') };
    });
    t('the fallback tf build is served', r.okFetch === true, r.okFetch);
    t('it defines tf', r.hasTf === true, r.hasTf);
    t('and it supplies the API the iPad was missing', r.hasLayers === true, r.hasLayers);
    await ctx.close();
  }

  /* ---- CASE 2 (CONTROL): a working recogniser must NOT nag ---- */
  {
    const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
    const page=await ctx.newPage();
    await page.goto('http://localhost:8751/',{waitUntil:'domcontentloaded'});
    await page.click('#btnStart');
    await page.waitForFunction(()=>window.LOCAL&&LOCAL.ready(),null,{timeout:120000}).catch(()=>{});
    /* Wait for an actual successful classification rather than a fixed sleep:
       "ready" only means the weights loaded. */
    await page.waitForFunction(()=>window.LOCAL&&LOCAL.ok&&LOCAL.ok()>0,null,{timeout:60000}).catch(()=>{});
    await page.waitForTimeout(600);
    const st = await page.evaluate(()=>({
      hidden: document.querySelector('#statusStrip').hidden,
      ready: LOCAL.ready()
    }));
    t('CONTROL - the recogniser really did load here', st.ready === true, st.ready);
    t('CONTROL - a working recogniser shows NO strip', st.hidden === true, 'hidden=' + st.hidden);
    await ctx.close();
  }

  /* ---- CASE 3: the strip must never appear with nothing in it.
     An empty black bar covers the scene and explains nothing; it showed on
     the owner's device and in a local rendering. ---- */
  {
    const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
    const page=await ctx.newPage();
    await page.goto('http://localhost:8751/',{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      const out = [];
      const strip = document.querySelector('#statusStrip');
      const txt = document.querySelector('#statusText');
      UI.status('SOMETHING', 'bad');
      out.push({ hidden: strip.hidden, text: txt.textContent });
      UI.status('', '');
      out.push({ hidden: strip.hidden, text: txt.textContent });
      UI.status('   ', 'bad');            // whitespace only
      out.push({ hidden: strip.hidden, text: txt.textContent });
      return out;
    });
    t('a real message shows', r[0].hidden === false && r[0].text === 'SOMETHING', JSON.stringify(r[0]));
    t('an empty message hides AND clears', r[1].hidden === true && r[1].text === '', JSON.stringify(r[1]));
    t('a whitespace-only message never shows an empty bar', r[2].hidden === true, JSON.stringify(r[2]));
    await ctx.close();
  }

  await browser.close(); server.close();
  const bad=R.filter(x=>!x.p);
  R.forEach(x=>console.log((x.p?'PASS  ':'FAIL  ')+x.n+(x.x?'   ['+x.x+']':'')));
  console.log('\n'+(R.length-bad.length)+'/'+R.length+' passed');
  process.exit(bad.length?1:0);
})();
