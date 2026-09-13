/* Two reports from the owner, both about the same page being unusable.

   "my ipad pro (m2) just froze on the settings page"

   Two separate faults, and the second was the freeze.

   Nothing paused: the detector, the classifier, the species model, the
   barcode decoder and the face pass all carried on over a camera nobody
   could see, and the overlay was redrawn every animation frame on top.

   And the code scanner was broken outright. The vendored zxing wasm was a
   different build (953,527 bytes) to the one barcode-detector 3.2.2's glue
   expects (zxing-wasm 3.1.3, 1,093,289 bytes), and a single decode took the
   renderer down. Safari has no BarcodeDetector of its own, so that wrong
   wasm was the only path an iPad had. With the builds matched, a barcode
   reads in 70ms and a code-free scene costs 7ms.

   "so many buttons inaccessible"

   Every control on the map page was under the 44-pixel floor - the zoom
   buttons 40 square, the layer chips 34 tall - and half of them were below
   the fold in a scrolling column.                                         */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.wasm':'application/wasm'};
const server=http.createServer((q,res)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
let pass=0,fail=0,crashed='';
/* A crashed page is neither a pass nor a fail unless somebody says so. The
   fault this suite was written for kills the renderer, so without this the
   whole file dies on a stack trace and reports nothing. */
const watch = p => { p.on('crash', () => { crashed = crashed || 'the page crashed'; }); return p; };
const ok=(n,c,x)=>{if(c){pass++;console.log('  ok   '+n);}else{fail++;console.log('  FAIL '+n+(x===undefined?'':'  '+JSON.stringify(x)));}};

(async()=>{
  await new Promise(r=>server.listen(0,r));
  const PORT = server.address().port;
  const {chromium}=require('playwright');
  const b=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});

  /* ---- every control on every panel, at the narrowest phone we support ---- */
  for (const size of [{w:390,h:844,name:'iPhone'},{w:768,h:1024,name:'iPad'}]) {
    const ctx=await b.newContext({permissions:['camera'],viewport:{width:size.w,height:size.h},serviceWorkers:'block'});
    const page=watch(await ctx.newPage());
    /* This half is about where the controls ARE. It does not need twelve
       megabytes of model weights to answer that, and fetching them made the
       suite take minutes. */
    await page.route('**/vendor/**', r => {
      if (/\.(bin|tflite|wasm)$/.test(r.request().url())) return r.abort();
      return r.continue();
    });
    await page.goto('http://127.0.0.1:'+PORT+'/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.MAP&&window.UI,null,{timeout:20000});
    await page.evaluate(()=>{
      const g=document.getElementById('gate'); g.classList.add('hidden'); g.hidden=true;
      GEO._set({lat:51.5074,lon:-0.1278,acc:12},40,
        [{title:'A Place',lat:51.5079,lon:-0.1281,dist:95,bearing:15}],{temp:16,code:1,wind:12});
      MAP.setOpen(true);
    });
    await page.waitForTimeout(350);

    console.log('\n' + size.name.toUpperCase() + '  ' + size.w + 'x' + size.h + '  MAP PAGE');
    const audit = await page.evaluate(()=>{
      const out=[];
      document.querySelectorAll('#mapPanel button, #mapPanel input').forEach(el=>{
        if (el.hidden || el.offsetParent === null) return;      // not on screen by design
        const r=el.getBoundingClientRect();
        const mid=document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
        out.push({ id: el.id || el.className, w: Math.round(r.width), h: Math.round(r.height),
                   onScreen: r.top >= 0 && r.bottom <= window.innerHeight,
                   hittable: !!(mid && (mid===el || el.contains(mid) || el.contains(mid.parentNode))) });
      });
      return out;
    });
    ok('SETUP: there are controls to check', audit.length >= 8, audit.length);
    const small = audit.filter(c=>c.w < 44 || c.h < 44);
    ok('every control meets the 44px touch floor', small.length === 0,
       small.map(c=>c.id+' '+c.w+'x'+c.h));
    const buried = audit.filter(c=>!c.onScreen);
    ok('every control is on screen without scrolling', buried.length === 0, buried.map(c=>c.id));
    const blocked = audit.filter(c=>!c.hittable);
    ok('and none of them is covered by something else', blocked.length === 0, blocked.map(c=>c.id));

    const stage = await page.evaluate(()=>{
      const c=document.getElementById('mapCanvas').getBoundingClientRect();
      return { w:Math.round(c.width), h:Math.round(c.height), frac: c.height/window.innerHeight };
    });
    ok('the map itself gets most of the page', stage.frac > 0.35, +stage.frac.toFixed(2));
    await ctx.close();
  }

  /* ---- nothing runs behind a panel ---- */
  console.log('\nNOTHING RUNS BEHIND A PANEL');
  const ctx=await b.newContext({permissions:['camera'],viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=watch(await ctx.newPage());
  await page.goto('http://127.0.0.1:'+PORT+'/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.UI&&window.SCAN&&window.LOCAL&&window.SPECIES,null,{timeout:30000});
  await page.evaluate(()=>{
    window.__c={scan:0,scene:0,species:0,draw:0};
    const s=SCAN.step; SCAN.step=function(v){ window.__c.scan++; return s.call(SCAN,v); };
    const sc=LOCAL.scene; LOCAL.scene=function(v,cb){ window.__c.scene++; return sc.call(LOCAL,v,cb); };
    const sp=SPECIES.identify; SPECIES.identify=function(){ window.__c.species++; return sp.apply(SPECIES,arguments); };
    const d=UI.draw; UI.draw=function(t){ window.__c.draw++; return d.call(UI,t); };
  });
  await page.click('#btnStart').catch(()=>{});
  /* Wait for the camera to actually be live rather than a fixed time - the
     fake stream takes a variable moment to start, and a fixed wait made
     this read "the pipeline is stopped" when it had simply not begun. */
  await page.waitForFunction(()=>CAM.live(), null, {timeout:20000});
  await page.waitForTimeout(800);

  const sample = async (ms)=>{ await page.evaluate(()=>Object.keys(window.__c).forEach(k=>window.__c[k]=0));
                               await page.waitForTimeout(ms);
                               return page.evaluate(()=>({...window.__c})); };

  const live = await sample(1500);
  /* Headless software GL with every model loaded ticks slowly, so what is
     asserted is that work HAPPENS - the discriminator is the paused case
     being exactly zero, not a frame rate this machine cannot reach. */
  /* The scene pass is PACED, so which of the classifiers lands inside a
     1.5s window depends on the machine - it read scene:0 with everything
     else moving once a third browser joined the suite. The setup only has
     to establish that work happens; the discriminator below is that the
     paused case is exactly zero, and that is unaffected. */
  ok('SETUP: with the camera showing, the pipeline runs',
     live.draw > 0 && (live.scene + live.species + live.scan) > 0, live);

  await page.evaluate(()=>{ document.getElementById('settings').hidden = false; });
  const behind = await sample(1500);
  ok('behind the settings page nothing is drawn', behind.draw === 0, behind);
  ok('and no classifier runs', behind.scene === 0 && behind.species === 0, behind);
  ok('and the code scanner stops', behind.scan === 0, behind);
  ok('the app knows it is paused', (await page.evaluate(()=>SL_PAUSED())).paused === true);

  await page.evaluate(()=>{ document.getElementById('settings').hidden = true; });
  const back = await sample(1500);
  ok('CONTROL: closing it starts everything again', back.draw > 0 && back.scene > 0, back);

  await page.evaluate(()=>{ MAP.setOpen(true); });
  const onMap = await sample(1200);
  ok('the map page pauses it too', onMap.draw === 0 && onMap.scene === 0, onMap);
  await page.evaluate(()=>{ MAP.setOpen(false); });

  console.log('\nTHE CODE SCANNER READS A CODE INSTEAD OF KILLING THE TAB');
  /* What froze the iPad was not the workload. The vendored zxing wasm was a
     different build to the one the ponyfill's glue expects, and one decode
     took the renderer down - on Safari, which has no scanner of its own, so
     that is the only path it has. Measured after matching them: a code-free
     camera scene costs 7ms at 540px, and a barcode reads in 70ms.

     So what is asserted is that a real barcode comes back with its real
     digits. A mismatched wasm cannot answer that; it closes the page. */
  const decoded = await page.evaluate(async () => {
    await SCAN.burst();                       // makes sure the decoder is loaded
    const api = window.BarcodeDetectionAPI;
    if (!api) return { no: 'the fallback decoder did not load' };
    /* EAN-13, the standard worked example, drawn from its own rule rather
       than pasted as a picture. */
    const CODE = '5901234123457';
    const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
    const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
    const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
    const P = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
    const d = CODE.split('').map(Number);
    let bits = '101'; const par = P[d[0]];
    for (let i = 1; i <= 6; i++) bits += (par[i-1] === 'L' ? L : G)[d[i]];
    bits += '01010';
    for (let i = 7; i < 13; i++) bits += R[d[i]];
    bits += '101';
    const MOD = 4, QUIET = 40, H = 220;
    const cv = document.createElement('canvas');
    cv.width = bits.length * MOD + QUIET * 2; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    cx.fillStyle = '#000';
    for (let i = 0; i < bits.length; i++) if (bits[i] === '1') cx.fillRect(QUIET + i*MOD, 20, MOD, H-40);

    const det = new api.BarcodeDetector({ formats: ['qr_code','ean_13','ean_8','upc_a','upc_e','code_128'] });
    const t0 = performance.now();
    const hits = await det.detect(cv);
    const readMs = Math.round(performance.now() - t0);

    /* And the case that actually runs all day: a scene with no code in it. */
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    cx.fillStyle = '#777';
    for (let i = 0; i < 40; i++) cx.fillRect((i*53) % cv.width, (i*31) % cv.height, 18, 60);
    const t1 = performance.now();
    await det.detect(cv);
    return { want: CODE, got: hits.map(h => h.rawValue), readMs,
             emptyMs: Math.round(performance.now() - t1) };
  });
  ok('SETUP: the fallback decoder loads at all', !decoded.no, decoded);
  ok('it reads a real barcode, digit for digit', (decoded.got||[]).indexOf(decoded.want) >= 0, decoded);
  ok('reading one is quick enough to do while the camera runs', decoded.readMs < 1500, decoded);
  ok('and a frame with no code in it is cheaper still', decoded.emptyMs < 600, decoded);

  const sc = await page.evaluate(()=>({ ...SCAN.state(), hasNative: !!window.BarcodeDetector }));
  ok('SETUP: this browser has no scanner of its own', sc.hasNative === false, sc.hasNative);
  ok('so it is watching with the fallback, not waiting to be asked',
     sc.ready === true && sc.native === false, sc);
  ok('and it says how many formats it is really looking for', sc.formats === 6, sc);

  /* "remove qr code button it should be automatic." It is: the scanner
     watches on its own, so there is no button to press. */
  const btn = await page.evaluate(()=>({ button: !!document.getElementById('btnScan'), watching: SCAN.state().ready }));
  ok('there is no scan button', btn.button === false, btn);
  ok('because the scanner is already watching', btn.watching === true, btn);
  /* ---- the rows under the weather sit where they were put ----

     "bad positioning", with a screenshot of the air quality row shoved to
     the right of its card and spilling past the edge. The cause was a NAME
     COLLISION: .srow belonged to the settings panel three hundred lines
     further down, with justify-content:space-between and no side padding,
     and being later it won. Nothing about the markup was wrong, so this
     asserts the GEOMETRY - where the text actually lands - which is the
     only thing that catches a rule written somewhere else. */
  console.log('\nTHE ROWS UNDER THE WEATHER');
  {
    const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const p2 = watch(await ctx2.newPage());
    await p2.route('**/vendor/**', r => (/\.(bin|tflite|wasm)$/.test(r.request().url()) ? r.abort() : r.continue()));
    await p2.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => window.UI && window.GEO, null, { timeout: 20000 });
    const r = await p2.evaluate(() => {
      const g = document.getElementById('gate'); g.classList.add('hidden'); g.hidden = true;
      GEO._set({ lat: 51.5, lon: -0.1, acc: 10 }, 135, [], { temp: 18, code: 51, wind: 10, aqi: 21 });
      const box = s => { const el = document.querySelector(s); if (!el) return null;
                         const b = el.getBoundingClientRect();
                         return { x: Math.round(b.x), r: Math.round(b.right), w: Math.round(b.width) }; };
      return { row: box('#aqRow'), ic: box('#aqRow .h-ic'), txt: box('#aqRow .s-t'),
               wx: box('#wxCard'), stack: box('#hudStack'),
               text: (document.getElementById('aqRowTxt') || {}).textContent || '' };
    });
    ok('SETUP: the air quality row is drawn', !!r.row && !!r.ic && !!r.txt && !!r.text, r);
    ok('its text begins just after its icon, not across the card',
       r.txt.x <= r.ic.r + 14, { iconEnds: r.ic.r, textStarts: r.txt.x });
    ok('and it stays inside the card', r.txt.r <= r.row.r - 6, { textEnds: r.txt.r, cardEnds: r.row.r });
    ok('the stack is the same width as the weather card above it',
       Math.abs(r.stack.w - r.wx.w) <= 2, { stack: r.stack.w, weather: r.wx.w });
    await ctx2.close();
  }

  /* ---- a tap on a control is not a tap on the camera ----

     "the new bottom menu when you tap on it also registers the look at
      object command like you tapped on an object on your screen."

     The guard was a DENY LIST of panel ids kept in two places, and the
     dock was in neither - so was the status pill, and the map panel. It
     is an allow list now, in one place: the video, the overlay, the
     stage. This walks every control the app has and checks none of them
     reads as the view. */
  console.log('\nTAPPING A CONTROL IS NOT TAPPING THE CAMERA');
  {
    const ctx3 = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const p3 = watch(await ctx3.newPage());
    await p3.route('**/vendor/**', r => (/\.(bin|tflite|wasm)$/.test(r.request().url()) ? r.abort() : r.continue()));
    await p3.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
    await p3.waitForFunction(() => window.UI && window.IDENT, null, { timeout: 20000 });
    const r = await p3.evaluate(() => {
      const g = document.getElementById('gate'); g.classList.add('hidden'); g.hidden = true;
      /* Every control that sits over the camera, dock included. */
      const ids = ['dockHome','dockMap','dockShot','dockSet','dockMore','btnFlip','btnVoice',
                   'btnCaptions','btnSettings','sceneChip','radarPod','nearCard','statusStrip',
                   'askChip','mapPanel','sheet','settings','captionBar'];
      const view = ['stage','cam','overlay'];
      const said = [];
      ids.forEach(id => { const el = document.getElementById(id);
                          if (el) said.push({ id, view: UI._onTheView(el) }); });
      const seenAsView = view.map(id => ({ id, view: UI._onTheView(document.getElementById(id)) }));
      return { said, seenAsView };
    });
    ok('SETUP: there are controls to check', r.said.length >= 10, r.said.length);
    ok('not one control reads as the camera view',
       r.said.every(x => x.view === false), r.said.filter(x => x.view));
    ok('CONTROL: the video, the overlay and the stage DO',
       r.seenAsView.every(x => x.view === true), r.seenAsView);
    await ctx3.close();
  }

  done(b);
})().catch(e => {
  const why = crashed || String(e && e.message || e).split('\n')[0];
  fail++;
  console.log('  FAIL the suite could not finish  ' + JSON.stringify(why));
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  process.exit(1);
});

function done(b){
  if (crashed) ok('the page never crashed', false, crashed);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  b.close().catch(()=>{}); server.close();
  setTimeout(()=>process.exit(fail?1:0), 100);
}
