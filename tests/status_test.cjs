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
    const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
    const page=await ctx.newPage();
    await page.route('**/vendor/models/**', r=>r.abort());        // local weights blocked
    await page.route('**storage.googleapis.com**', r=>r.abort()); // and every remote source
    await page.route('**tfhub.dev**', r=>r.abort());
    await page.goto('http://localhost:8751/',{waitUntil:'domcontentloaded'});
    await page.click('#btnStart');
    await page.waitForTimeout(9000);

    const st = await page.evaluate(()=>{
      const s=document.querySelector('#statusStrip');
      return { hidden:s.hidden, text:(document.querySelector('#statusText')||{}).textContent||'',
               cls:s.className, diag: window.SL_DIAG ? SL_DIAG() : null };
    });
    t('a failed recogniser shows the status strip', st.hidden === false, 'hidden=' + st.hidden);
    t('the strip states it FAILED', /FAILED|ERROR/.test(st.text), st.text.slice(0,90));
    t('the strip carries a reason, not just a label', st.text.length > 24, st.text.length + ' chars');
    t('it is styled as bad, not as normal', /bad/.test(st.cls), st.cls);
    t('it points at the recovery action', /RELOAD MODELS|CFG/.test(st.text), st.text.slice(0,90));
    t('diagnostics agree the classifier failed',
      st.diag && /failed/.test(st.diag.classifier), st.diag && st.diag.classifier);
    await ctx.close();
  }

  /* ---- CASE 2 (CONTROL): a working recogniser must NOT nag ---- */
  {
    const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
    const page=await ctx.newPage();
    await page.goto('http://localhost:8751/',{waitUntil:'domcontentloaded'});
    await page.click('#btnStart');
    await page.waitForFunction(()=>window.LOCAL&&LOCAL.ready(),null,{timeout:120000}).catch(()=>{});
    await page.waitForTimeout(2500);
    const st = await page.evaluate(()=>({
      hidden: document.querySelector('#statusStrip').hidden,
      ready: LOCAL.ready()
    }));
    t('CONTROL - the recogniser really did load here', st.ready === true, st.ready);
    t('CONTROL - a working recogniser shows NO strip', st.hidden === true, 'hidden=' + st.hidden);
    await ctx.close();
  }

  await browser.close(); server.close();
  const bad=R.filter(x=>!x.p);
  R.forEach(x=>console.log((x.p?'PASS  ':'FAIL  ')+x.n+(x.x?'   ['+x.x+']':'')));
  console.log('\n'+(R.length-bad.length)+'/'+R.length+' passed');
  process.exit(bad.length?1:0);
})();
