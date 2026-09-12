/* Naming the species, on the device.

   "find free species id thing then" - and there is one. Google's AIY
   iNaturalist classifiers, mirrored in google-coral/test_data under Apache
   2.0: 2,102 plants, 1,021 insects, 965 birds, as TFLite, which runs in a
   browser over WebAssembly. No key, no account, no quota.

   This proves it on the reference photographs those models ship with -
   a sunflower and a parrot - because a drawn green ellipse is not a plant
   and a model that called it one would be worse, not better.

   The controls are the point: a build that answered "sunflower" to
   everything would pass the first assertion on its own.                   */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
            '.svg':'image/svg+xml','.wasm':'application/wasm','.bmp':'image/bmp','.jpg':'image/jpeg'};
const server=http.createServer((q,res)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('  ok   '+n);}else{fail++;console.log('  FAIL '+n+(x===undefined?'':'  '+JSON.stringify(x)));}};

(async()=>{
  await new Promise(r=>server.listen(8745,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  const missing=[]; page.on('response',r=>{ if(r.status()>=400) missing.push(r.url().split('/').pop()); });

  await page.goto('http://127.0.0.1:8745/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.SPECIES,null,{timeout:30000});

  /* The runtime is 1.2 MB and most sessions never point at anything alive,
     so it is NOT part of the boot. That is a property worth pinning: a
     future change that loads it eagerly undoes the whole point of
     deferring the libraries. */
  ok('the runtime is not fetched at boot',
     await page.evaluate(()=>SPECIES.state().runtime) === 'not asked for yet');
  ok('it arrives when something alive is asked about',
     await page.evaluate(()=>SPECIES.runtimeReady()) === true);

  /* Draws a photograph into a canvas that answers like a video element, so
     the real identify() path runs unchanged. */
  const run = (src, kind) => page.evaluate(async ([src,kind])=>{
    await SPECIES.load(kind);
    const img = new Image();
    await new Promise((res,rej)=>{ img.onload=res; img.onerror=()=>rej(new Error('image '+src)); img.src=src; });
    const v=document.createElement('canvas'); v.width=img.width; v.height=img.height;
    Object.defineProperty(v,'videoWidth',{value:img.width});
    Object.defineProperty(v,'videoHeight',{value:img.height});
    v.getContext('2d').drawImage(img,0,0);
    return await SPECIES.identify(v,[0,0,img.width,img.height],kind);
  },[src,kind]);

  console.log('\nA PHOTOGRAPH OF A SUNFLOWER');
  const sun = await run('/tests/fixtures/sunflower.bmp','plant');
  ok('it returns an answer at all', !!sun, sun);
  ok('and the answer is a sunflower', !!sun && /helianthus/i.test(sun.scientific), sun && [sun.scientific,sun.name]);
  ok('with a binomial, not just a common name', !!sun && /^[A-Z][a-z]+ [a-z]+/.test(sun.scientific), sun && sun.scientific);
  ok('and a common name a person would use', !!sun && sun.name && sun.name !== sun.scientific, sun && sun.name);
  ok('it is sure about it', !!sun && sun.sure === true, sun && {score:+sun.score.toFixed(2), margin:+sun.margin.toFixed(2)});
  ok('and it took under 400ms', !!sun && sun.ms < 400, sun && sun.ms);

  console.log('\nA PHOTOGRAPH OF A PARROT');
  const bird = await run('/tests/fixtures/parrot.jpg','bird');
  ok('CONTROL: a different photograph gets a different answer',
     !!bird && !!sun && bird.scientific !== sun.scientific, bird && [bird.scientific, bird.name]);
  ok('and it is a bird, not a plant', !!bird && !/helianthus/i.test(bird.scientific), bird && bird.scientific);

  console.log('\nWHEN IT IS NOT LOOKING AT A SPECIES');
  const nothing = await page.evaluate(async ()=>{
    await SPECIES.load('plant');
    const v=document.createElement('canvas'); v.width=640; v.height=480;
    Object.defineProperty(v,'videoWidth',{value:640});
    Object.defineProperty(v,'videoHeight',{value:480});
    const g=v.getContext('2d'); g.fillStyle='#cfd6c8'; g.fillRect(0,0,640,480);
    g.fillStyle='#2f6b32'; g.beginPath(); g.ellipse(320,240,150,90,0.4,0,7); g.fill();
    return await SPECIES.identify(v,[170,90,300,300],'plant');
  });
  ok('a drawn shape is not named as a plant', nothing === null, nothing);

  console.log('\nONE MODEL AT A TIME');
  const st = await page.evaluate(()=>SPECIES.state());
  ok('only the models actually needed were fetched', st.loaded.length <= 2 && st.loaded.indexOf('insect') === -1, st.loaded);
  ok('nothing failed to load', Object.keys(st.failed).length === 0, st.failed);
  ok('SETUP: it knows more than four thousand species',
     st.counts.plant + st.counts.insect + st.counts.bird > 4000, st.counts);

  ok('every file it asked for existed', missing.length === 0, missing);
  ok('no page errors throughout', errs.length === 0, errs);

  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
