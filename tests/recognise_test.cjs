/* Proves the recogniser actually runs, using only files this repo serves.

   Every earlier suite had to skip this: the weights came from Google hosts
   the build sandbox cannot reach, so "does it identify anything" was never
   tested. With the weights vendored it is testable, and the key property is
   that NO third-party request happens at all. */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css',
            '.json':'application/json','.svg':'image/svg+xml','.bin':'application/octet-stream'};
const server=http.createServer((q,res)=>{
  let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});
  res.end(fs.readFileSync(f));
});

(async()=>{
  await new Promise(r=>server.listen(8741,r));
  const {chromium}=require('playwright');
  const browser=await chromium.launch({args:[
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const ctx=await browser.newContext({permissions:['camera'],viewport:{width:414,height:896}});
  const page=await ctx.newPage();

  const external=[], errs=[], reqs=[];
  page.on('request',r=>{ reqs.push(r.url()); const u=new URL(r.url()); if(u.host!=='localhost:8741') external.push(u.host); });
  page.on('pageerror',e=>errs.push(e.message.slice(0,120)));

  await page.goto('http://localhost:8741/',{waitUntil:'domcontentloaded'});
  await page.click('#btnStart');

  const ready = await page.waitForFunction(
    ()=>window.LOCAL && LOCAL.ready() && document.querySelector('#cam').videoWidth > 0,
    null, {timeout:120000}).then(()=>true).catch(()=>false);

  const R=[]; const t=(n,c,x)=>R.push({n,p:!!c,x:x===undefined?'':String(x)});
  t('the recogniser loaded', ready===true, ready ? '' : (await page.evaluate(()=>LOCAL.lastError())));

  if (ready) {
    const r = await page.evaluate(async () => {
      const out = {};
      out.timing = LOCAL.timing();

      /* Classify a real frame through the real code path. */
      const pad = document.createElement('canvas'); pad.width=pad.height=224;
      const c = pad.getContext('2d');
      c.drawImage(document.querySelector('#cam'),0,0,224,224);

      const vid = document.querySelector('#cam');
      let fake = null;
      for (let i = 0; i < 4 && (!fake || fake.localState !== 'done'); i++) {
        fake = {id:-9, cls:'object', box:[0,0,Math.min(400,vid.videoWidth),Math.min(400,vid.videoHeight)],
                raw:[0,0,Math.min(400,vid.videoWidth),Math.min(400,vid.videoHeight)],
                localState:'', local:null, tier:'', label:'', scan:'plotted', why:'', settled:0};
        await LOCAL.label(vid, fake);
        if (fake.localState !== 'done') await new Promise(r=>setTimeout(r,400));
      }
      out.labelled = fake.localState;
      out.name = fake.local && fake.local.name;
      out.score = fake.local && fake.local.score;
      out.ms = fake.local && fake.local.ms;
      out.scan = fake.scan;              // the verdict lifecycle
      out.why = fake.why;

      /* Scene mode: the realtime path. The app's own loop is already running
         it, and LOCAL.scene() refuses a concurrent call, so calling it again
         here measured the guard rather than the recogniser. Wait for the
         running loop to produce a result instead. */
      out.scene = await new Promise(res=>{
        const t0 = Date.now();
        (function poll(){
          const r = LOCAL.sceneLast();
          if (r) return res(r);
          if (Date.now() - t0 > 20000) return res(null);
          setTimeout(poll, 250);
        })();
      });
      out.classCount = window.KH_IMAGENET ? window.KH_IMAGENET.length : 0;
      return out;
    });

    /* label() either names the crop or declines it when the best guess is
       below the confidence floor. Both are correct; demanding a name from a
       synthetic camera pattern asserted the test's luck, not the app. */
    t('classification ran to completion', r.labelled === 'done', r.labelled);
    t('it either named the crop or cleanly declined',
      r.labelled === 'done' && (r.name === null || typeof r.name === 'string'),
      r.name === null ? 'declined (below floor)' : r.name);
    if (r.name) {
      t('the score is a real probability', r.score > 0 && r.score <= 1, r.score);
      t('timing was recorded', r.ms > 0, r.ms + 'ms');
    }
    t('every scan reaches a verdict, never limbo',
      r.scan === 'relevant' || r.scan === 'dismissed', r.scan + (r.why ? ' / ' + r.why : ''));
    t('a dismissal carries a stated reason',
      r.scan !== 'dismissed' || !!r.why, r.why || 'n/a');
    t('the scene path produced a real probability', r.scene && r.scene.score > 0 && r.scene.score <= 1, r.scene && r.scene.score);
    t('the scene path recorded its timing', r.scene && r.scene.ms > 0, r.scene && (r.scene.ms + 'ms'));
    t('scene mode returned a label', r.scene && !!r.scene.name, r.scene && r.scene.name);
    t('scene label carries a category', r.scene && !!r.scene.kind, r.scene && r.scene.kind);
    t('the model came from our own origin', /local/.test(r.timing.model), r.timing.model);
    t('CONTROL - all 1000 class names are present', r.classCount === 1000, r.classCount);
    t('CONTROL - backend is a real one', !!r.timing.backend, r.timing.backend);

    const shown = await page.evaluate(()=>!document.querySelector('#sceneChip').hidden);
    t('the live readout is on screen', shown === true, shown);
  }

  /* THE property, scoped correctly: the RECOGNISER touches no third party.
     The detector (coco-ssd) still fetches its weights remotely - it is
     optional, non-blocking, and its failure only costs multi-object boxes -
     so a request from it must not fail this. tfhub.dev must never appear:
     that host is deprecated and is what broke identification before. */
  const hosts=[...new Set(external)];
  const classifierLocal = reqs.some(u => /\/vendor\/models\/mobilenet/.test(u));
  t('the classifier weights came from our own origin', classifierLocal, classifierLocal ? 'vendor/models/…' : 'NOT SERVED LOCALLY');
  t('tfhub.dev was never contacted', !hosts.some(h => /tfhub/.test(h)), hosts.join(',') || 'none');
  /* The detector's weights are vendored now too, so the claim is absolute:
     identification contacts NOTHING outside this origin. That is what makes
     it work on a network that blocks Google hosts, and offline. */
  t('NO third-party host is contacted at all', hosts.length === 0, hosts.join(',') || 'none');
  t('the detector weights also came from our own origin',
    reqs.some(u => /\/vendor\/models\/coco-ssd-lite/.test(u)), 'vendor/models/coco-ssd-lite');
  t('CONTROL - the page did not throw', errs.length === 0, errs.join('|').slice(0,120));

  await browser.close(); server.close();
  const bad=R.filter(x=>!x.p);
  R.forEach(x=>console.log((x.p?'PASS  ':'FAIL  ')+x.n+(x.x?'   ['+x.x+']':'')));
  console.log('\n'+(R.length-bad.length)+'/'+R.length+' passed');
  process.exit(bad.length?1:0);
})();
