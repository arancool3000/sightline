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
let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('  ok   '+n);}else{fail++;console.log('  FAIL '+n+(x===undefined?'':'  '+JSON.stringify(x)));}};

(async()=>{
  await new Promise(r=>server.listen(0,r));
  const PORT = server.address().port;
  const {chromium}=require('playwright');
  const b=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});

  /* ---- every control on every panel, at the narrowest phone we support ---- */
  for (const size of [{w:390,h:844,name:'iPhone'},{w:768,h:1024,name:'iPad'}]) {
    const ctx=await b.newContext({permissions:['camera'],viewport:{width:size.w,height:size.h},serviceWorkers:'block'});
    const page=await ctx.newPage();
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
  const page=await ctx.newPage();
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
  ok('SETUP: with the camera showing, the pipeline runs', live.draw > 0 && live.scene > 0, live);

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

  const btn = await page.evaluate(()=>{
    const el = document.getElementById('btnScan');
    const r = el.getBoundingClientRect();
    return { shown: !el.hidden, w: Math.round(r.width), h: Math.round(r.height) };
  });
  ok('there is still a button to ask for a look now', btn.shown === true, btn);
  ok('which meets the touch floor', btn.w >= 44 && btn.h >= 44, btn);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
