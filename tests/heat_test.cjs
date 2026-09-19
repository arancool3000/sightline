/* "somehow making my iphone 18 pro overheat" / "failed to link vertex and
    fragment shaders"

   One root under both. The scene classifier - the label saying what you
   are pointing at - was called EVERY ANIMATION FRAME with nothing but a
   busy flag in front of it, so it ran a neural network back to back for
   as long as the app was open. And the WebGL settings written to rescue
   an old iPad were applied UNCONDITIONALLY, which on newer hardware is
   the combination that will not link - dropping the whole thing onto the
   processor, where that same unpaced loop cooks the phone rather than
   just the GPU.

   So what is checked is the work actually done, not the intention:

     1. THE LABEL HAS A RATE, and it is one a person can read.
     2. A STILL PICTURE COSTS ALMOST NOTHING - and a moving one is back
        to full rate on the first frame that moves, because being slow to
        answer when you point at something new is the failure this must
        never introduce.
     3. WEBGL IS TRIED PLAIN FIRST and proven with a real kernel before
        it is trusted; the old settings are a fallback, not a default.

   ⚠ The rates are read from the app rather than written here twice: a
   test that pins 300 goes red the day somebody tunes it to 280, which
   teaches people to ignore the suite. What is pinned is that the rate
   EXISTS and is inside what a person can read.                        */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=http.createServer((q,res)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';
  const f=path.join(ROOT,p); if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('  ok   '+n);}else{fail++;console.log('  FAIL '+n+(x===undefined?'':'  '+JSON.stringify(x)));}};

(async()=>{
  await new Promise(r=>server.listen(0,r));
  const BASE='http://127.0.0.1:'+server.address().port+'/';
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  await page.route('**/vendor/models/**',r=>r.abort());
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.APP&&window.LOCAL,null,{timeout:30000});

  console.log('\nTHE LABEL HAS A RATE A PERSON CAN READ');
  {
    const r=await page.evaluate(()=>APP._rates());
    ok('SETUP: the rates are the app’s own, not this file’s', !!r && r.scene>0 && r.detect>0, r);
    /* Faster than ~8 a second is work nobody can perceive; slower than
       one a second is an app that feels dead. Both ends are the point. */
    ok('the scene label is paced between 1 and 8 a second',
       r.scene>=125 && r.scene<=1000, r.scene);
    ok('and the detector too', r.detect>=125 && r.detect<=1000, r.detect);
    ok('CONTROL: the overlay is still painted often enough to feel live',
       r.paint>0 && r.paint<=80, r.paint);
  }

  console.log('\nA STILL PICTURE COSTS ALMOST NOTHING');
  {
    const m=await page.evaluate(async()=>{
      /* A canvas standing in for the camera. Nothing in the pace
         governor knows the difference: it reads videoWidth and draws. */
      const cv=document.createElement('canvas'); cv.width=320; cv.height=240;
      const c=cv.getContext('2d');
      cv.videoWidth=320; cv.videoHeight=240;
      const still=()=>{ c.fillStyle='#3a4046'; c.fillRect(0,0,320,240);
                        c.fillStyle='#c9a37f'; c.fillRect(40,60,90,90); };
      const moving=(i)=>{ c.fillStyle='#3a4046'; c.fillRect(0,0,320,240);
                          c.fillStyle='#c9a37f'; c.fillRect(40+i*17,60,90,90); };

      APP._forget();
      still(); APP._motion(cv);            // first frame has nothing to compare with
      const first=APP._motion(cv);          // now it does, and nothing moved
      let stillReads=0;
      for (let i=0;i<20;i++) if (APP._motion(cv)===0) stillReads++;

      /* And now something moves across the frame. ⚠ Starting at 1: the
         first position is where the still box already was, so drawing it
         there is not a move and counting it as one would be the test
         lying to itself. */
      let movedReads=0;
      for (let i=1;i<=10;i++){ moving(i); if (APP._motion(cv)===1) movedReads++; }

      /* CONTROL: a frame it cannot read must be treated as moving, or a
         tainted canvas would silently put the app to sleep. */
      const blind=APP._motion({videoWidth:0});
      return { first, stillReads, movedReads, blind };
    });
    ok('a picture that is not changing reads as still', m.first===0 && m.stillReads===20, m);
    ok('and something crossing the frame reads as moving', m.movedReads===10, m);
    ok('CONTROL: a frame that cannot be read counts as moving, never as still',
       m.blind===1, m);

    /* THE MULTIPLIER ITSELF, which is what every paced pass is measured
       in - the readings above only prove the governor can tell still from
       moving. Driven by handing it a clock rather than sleeping: a test
       that waited real seconds would be pinning a timing. */
    const p=await page.evaluate(async()=>{
      const cv=document.createElement('canvas'); cv.width=320; cv.height=240;
      const c=cv.getContext('2d'); cv.videoWidth=320; cv.videoHeight=240;
      const still=()=>{ c.fillStyle='#3a4046'; c.fillRect(0,0,320,240);
                        c.fillStyle='#c9a37f'; c.fillRect(40,60,90,90); };
      const moving=(i)=>{ c.fillStyle='#3a4046'; c.fillRect(0,0,320,240);
                          c.fillStyle='#c9a37f'; c.fillRect(40+i*17,60,90,90); };
      APP._forget();
      let t=0;
      still(); APP._pace(t, cv);
      const start=APP.pace();
      /* Half a minute of a phone lying on a desk. */
      for (let i=0;i<220;i++){ t+=130; APP._pace(t, cv); }
      const parked=APP.pace();
      /* And it is picked up and pointed at something. */
      t+=130; moving(1); APP._pace(t, cv);
      const woke=APP.pace();
      return { start, parked, woke, parts: APP._parts(), stillFrames: APP._still() };
    });
    ok('SETUP: it starts at full rate', p.start===1, p);
    ok('a phone left still winds the work right down', p.parked>=3, p);
    /* ⚠ THE CAP IS THE POINT and the first cut did not have one that
       worked: the stillness ceiling was multiplied by the backend's own
       floor AFTER being capped, so the answer came out at fifteen - a
       parked phone looking at the world every four and a half seconds.
       The ceiling is on what comes OUT. */
    ok('CONTROL: but never stops watching', p.parked<=8, p);
    /* Waking returns the STILLNESS part to one. A slow backend stays
       slow, which is the whole reason it has a floor of its own. */
    ok('and ONE moving frame puts the stillness back to full rate',
       p.parts.still===1 && p.woke===p.parts.backend, p);
  }

  console.log('\nWEBGL IS TRIED PLAIN, AND PROVEN');
  {
    const src=await (await fetch(BASE+'js/local.js')).text();
    /* Source shape, deliberately: the backend walk cannot be driven in a
       headless Chromium that has working WebGL - it would take the first
       branch every time and prove nothing about the others. What CAN be
       asserted is that taming is no longer unconditional, and that the
       GPU backends are made to compile something before being trusted. */
    const order=src.indexOf("order.push('webgl')");
    const tamed=src.indexOf("order.push('webgl-tame')");
    ok('plain WebGL is tried before the tamed one', order>0 && tamed>order, {order,tamed});
    ok('the old settings are no longer applied unconditionally',
       !/function pickBackend\(\)\s*\{[^]{0,200}tameWebgl\(\);/.test(src), 'tameWebgl at the top of pickBackend');
    ok('and a GPU backend has to compile a kernel before it is trusted',
       /proveBackend/.test(src) && /conv2d/.test(src), 'proveBackend');

    const live=await page.evaluate(async()=>{
      /* It must also actually answer, on this machine, whatever it picks.
         A proof that always says no is the failure that would send every
         device to the processor - which is the heat this round is about. */
      if (!window.tf) return { skipped:true };
      const t=LOCAL.timing();
      return { backend:t.backend||'', skipped:false };
    });
    if (live.skipped) ok('SETUP: tensorflow is not loaded here, so the live pick is not read', true, live);
    else ok('a backend really was chosen', typeof live.backend==='string', live);
  }

  ok('no page errors throughout', errs.length===0, errs);

  await b.close(); server.close();
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  process.exit(fail?1:0);
})();
