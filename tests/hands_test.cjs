/* "hand tracking is very bad" ... "hand tracking is very very bad."

   Twice, so the colour heuristic was the wrong instrument and a third
   round of tuning it would have been the same mistake again. This tests
   the replacement: MediaPipe's palm detector and hand landmarker, run
   from vendored .tflite files with no key and no network.

   AND IT IS TESTED ON PHOTOGRAPHS OF ACTUAL HANDS. A synthetic blob
   proves nothing about a model trained on people - the old suite drew a
   skin-coloured rectangle and was perfectly happy while the thing did
   not work in a room. The fixtures are MediaPipe's own test images,
   vendored beside the tests.

   The discriminators, each chosen so a broken build cannot pass:

     1. A HAND IS FOUND, confidently, in every photograph.
     2. THE SKELETON IS ON THE HAND - not near it, and not off the
        picture. The first cut put the crop region at y = 1.26, off the
        bottom of the world, and every landmark came back from a black
        square; "it returned 21 points" would have passed that.
     3. THE POINTING FINGER POINTS. In the photograph of a hand pointing
        up, the index fingertip must be ABOVE the wrist - which is a fact
        about the picture, not about any implementation.
     4. TWO HANDS ARE TWO HANDS, one left and one right.
     5. CONTROL: an empty wall is not a hand.                          */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm',
            '.tflite':'application/octet-stream','.json':'application/json','.jpg':'image/jpeg','.png':'image/png'};
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
  const ctx=await b.newContext({serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.HANDS&&window.VR,null,{timeout:30000});

  console.log('\nTHE MODELS LOAD, FROM THIS REPO');
  const loaded=await page.evaluate(()=>HANDS.load().then(ok=>({ok, why:HANDS.why(), anchors:HANDS._anchors()})));
  ok('the vendored models load with no network beyond this origin', loaded.ok===true, loaded);
  /* The anchor grid has to be rebuilt exactly as it was at training time
     or every box lands somewhere else. The count is the check. */
  ok('the anchor grid comes to the 2016 the detector answers with', loaded.anchors===2016, loaded);
  if (!loaded.ok) { console.log('\n  the rest cannot run without them'); await b.close(); server.close(); process.exit(1); }

  /* One photograph, run through the real door the game uses. */
  const look=(file)=>page.evaluate(async(file)=>{
    const img=await new Promise((res,rej)=>{const i=new Image(); i.onload=()=>res(i); i.onerror=rej;
      i.src='tests/fixtures/hands/'+file;});
    const cv=document.createElement('canvas'); cv.width=img.width; cv.height=img.height;
    cv.getContext('2d').drawImage(img,0,0);
    cv.videoWidth=img.width; cv.videoHeight=img.height;
    HANDS.forget(); HANDS.step(cv);
    const st=HANDS.state();
    const pack=(h)=>h.seen?{seen:true,x:+h.x.toFixed(3),y:+h.y.toFixed(3),n:h.n,
      wrist:h.pts[0].map(v=>+v.toFixed(3)), tip:h.pts[8].map(v=>+v.toFixed(3)),
      inside:h.pts.every(p=>p[0]>-0.05&&p[0]<1.05&&p[1]>-0.05&&p[1]<1.05),
      spread:Math.max(...h.pts.map(p=>p[0]))-Math.min(...h.pts.map(p=>p[0]))}:{seen:false};
    return { left:pack(st.left), right:pack(st.right) };
  },file);

  console.log('\nA HAND POINTING UP');
  {
    const r=await look('pointing_up.jpg');
    const h=r.left.seen?r.left:r.right;
    ok('a hand is found', h.seen===true, r);
    ok('with all twenty-one landmarks', h.n===21, h);
    /* ⚠ THE ONE THAT CATCHES A CROP GONE ASTRAY. Landmarks from a black
       square still arrive as 21 numbers and still look like a hand; what
       they do not do is sit inside the picture. */
    ok('and every one of them inside the picture', h.inside===true, h);
    /* A fact about the photograph, true of no broken build by luck. */
    ok('the pointing finger is above the wrist', h.tip[1] < h.wrist[1]-0.1, h);
    ok('and the hand takes a sensible part of the frame',
       h.spread>0.05 && h.spread<0.8, h.spread);
  }

  console.log('\nA THUMB UP');
  {
    const r=await look('thumb_up.jpg');
    const h=r.left.seen?r.left:r.right;
    ok('a hand is found here too', h.seen===true, r);
    ok('CONTROL: and its landmarks are on the picture', h.inside===true, h);
  }

  console.log('\nTWO HANDS ARE TWO HANDS');
  {
    const r=await look('right_hands.jpg');
    ok('both are found', r.left.seen===true && r.right.seen===true, r);
    ok('and the left one is the one further left',
       r.left.seen && r.right.seen && r.left.x < r.right.x, r);
    ok('CONTROL: they are not the same hand counted twice',
       Math.abs(r.left.x-r.right.x)>0.1, r);
  }

  console.log('\nCONTROL: A WALL IS NOT A HAND');
  {
    const r=await page.evaluate(()=>{
      const cv=document.createElement('canvas'); cv.width=640; cv.height=480;
      const c=cv.getContext('2d');
      /* A plain wall, and then a big skin-coloured rectangle on it - the
         exact thing the old colour tracker called a hand. */
      c.fillStyle='#cdc8c0'; c.fillRect(0,0,640,480);
      c.fillStyle='#d9a487'; c.fillRect(180,140,260,260);
      cv.videoWidth=640; cv.videoHeight=480;
      HANDS.forget();
      for (let i=0;i<3;i++) HANDS.step(cv);
      const st=HANDS.state();
      return { left:st.left.seen, right:st.right.seen };
    });
    ok('a skin-coloured rectangle is not a hand', r.left===false && r.right===false, r);
  }

  console.log('\nTHE GAME USES IT, AND FALLS BACK WITHOUT IT');
  {
    const v=await page.evaluate(()=>{
      const realGood=HANDS.good;
      HANDS.good=()=>true;
      const withModel=VR._real();
      HANDS.good=()=>false;
      const without=VR._real();
      /* With no model the skin tracker must still answer, or a device
         that cannot load four megabytes gets a game it cannot play. */
      const cv=document.createElement('canvas'); cv.width=320; cv.height=240;
      const c=cv.getContext('2d');
      c.fillStyle='#2b2f33'; c.fillRect(0,0,320,240);
      c.fillStyle='#d9a487'; c.fillRect(230,170,60,60);
      cv.videoWidth=320; cv.videoHeight=240;
      for (let i=0;i<14;i++) VR._readAny(cv);
      const skin=VR._hands();
      HANDS.good=realGood;
      return { withModel, without, skinSaw: skin.right.seen||skin.left.seen };
    });
    ok('the game asks the model when it is there', v.withModel===true, v);
    ok('CONTROL: and the colour tracker when it is not', v.without===false && v.skinSaw===true, v);
  }

  ok('no page errors throughout', errs.length===0, errs);

  await b.close(); server.close();
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  process.exit(fail?1:0);
})();
