/* "landscape on iphone looks horrendous."

   It was every panel sized for a tall screen: on 390 points of height
   the two HUD columns, a subject chip floating in the middle of the
   picture and a 58-point dock left almost nothing to look THROUGH, and
   the dossier arrived as a full-width slab - one column of text 844
   points wide, which is an unreadable line length, over the thing it was
   describing.

   What is checked here is the three rules that fix it, each stated so a
   do-nothing build fails:

     1. THE MIDDLE BELONGS TO THE VIEW. A generous box through the centre
        of the screen has no panel in it. A build that only shrank the
        text passes "it fits"; it does not pass this.
     2. THE DOSSIER IS A COLUMN, NOT A SLAB. It takes one side, leaves
        the view visible, and its text sits at a readable width.
     3. THE DOCK STEPS OUT FROM UNDER IT.

   And the controls: PORTRAIT MUST NOT CHANGE. A landscape fix that
   quietly reflows the tall layout has broken the case that was working. */
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
  const errs=[];

  /* One page per shape, driven the way a finger does. */
  const look=async(w,h)=>{
    const ctx=await b.newContext({viewport:{width:w,height:h},hasTouch:true,isMobile:true,serviceWorkers:'block'});
    const page=await ctx.newPage();
    page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
    await page.route('**/vendor/models/**',r=>r.abort());
    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.UI,null,{timeout:30000});
    await page.waitForTimeout(700);
    try{ await page.click('#btnStart',{timeout:2500}); }catch(e){}
    await page.waitForTimeout(900);
    /* The gate covers the middle by design and there is no camera here
       to dismiss it, so it is put away explicitly - and asserted away,
       because a probe measuring a screen with the start card still on it
       is measuring the start card. */
    await page.evaluate(()=>{ const g=document.getElementById('gate');
      if(g){ g.hidden=true; g.classList.add('hidden'); g.style.display='none'; } });
    const out=await page.evaluate(()=>{
      const box=(id)=>{const e=document.getElementById(id); if(!e) return null;
        const cs=getComputedStyle(e);
        if(e.hidden||cs.display==='none'||cs.visibility==='hidden') return null;
        const r=e.getBoundingClientRect();
        return {l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),b:Math.round(r.bottom),
                w:Math.round(r.width),h:Math.round(r.height)};};

      /* THE CLEAR MIDDLE: the middle half across, and the band between
         the top cards and the dock. Anything painted in there is in the
         way of the thing the camera is pointed at. */
      const mx0=innerWidth*0.30, mx1=innerWidth*0.70;
      const my0=innerHeight*0.22, my1=innerHeight*0.72;
      const intruders=[...document.querySelectorAll('body *')].filter(e=>{
        const cs=getComputedStyle(e);
        if(cs.display==='none'||cs.visibility==='hidden') return false;
        if(cs.position!=='absolute'&&cs.position!=='fixed') return false;
        /* Only things that PAINT: a transparent positioning wrapper is
           not in anybody's way. */
        const paints=cs.backgroundImage!=='none'||
          (cs.backgroundColor&&cs.backgroundColor!=='rgba(0, 0, 0, 0)')||
          cs.borderTopWidth!=='0px';
        if(!paints) return false;
        if(['cam','overlay','stage','app','vrStereoCv','gate','toast'].indexOf(e.id)>=0) return false;
        /* The viewfinder frame is drawn ACROSS the middle on purpose -
           it is what says where the app is looking - and a toast is a
           sentence that leaves by itself. Neither is a panel sitting in
           the way. */
        if(e.closest&&(e.closest('#gate')||e.closest('#toast'))) return false;
        if(String(e.className).split(' ').indexOf('frame')>=0) return false;
        const r=e.getBoundingClientRect();
        if(!r.width||!r.height) return false;
        /* The viewfinder corners are drawn ON the subject on purpose. */
        if((e.className||'').toString().indexOf('reticle')>=0) return false;
        return r.left<mx1&&r.right>mx0&&r.top<my1&&r.bottom>my0;
      }).map(e=>(e.id||e.tagName+'.'+String(e.className).split(' ')[0]));

      const dockBefore=box('dock');
      UI._showSheet('<h2>ENDER-3 V3 PLUS</h2><p class="muted">A 3D printer made by Creality.</p>'+
                    '<p>The Ender-3 V3 Plus is a large-format Cartesian printer with a heated bed.</p>');
      const sheet=box('sheet');
      const dockAfter=box('dock');
      const para=document.querySelector('#sheetBody p');
      const paraW=para?Math.round(para.getBoundingClientRect().width):0;
      UI._closeSheet();
      return { vp:[innerWidth,innerHeight], intruders,
               gateGone: (function(){var g=document.getElementById('gate');
                 return !g || getComputedStyle(g).display==='none';})(), dockBefore, dockAfter, sheet, paraW,
               hudTL:box('hudTL'), pod:box('radarPod'), chip:box('sceneChip') };
    });
    await ctx.close();
    return out;
  };

  console.log('\nA PHONE ON ITS SIDE');
  const L=await look(844,390);
  {
    ok('SETUP: it really is the short shape, with the start card away',
       L.vp[1]===390 && L.gateGone===true, L.vp);
    /* ⚠ A GUARD, NOT A DISCRIMINATOR. With the landscape block removed
       this line stays green, because the panel that used to sit in the
       middle - the subject chip - is only on screen once something has
       been recognised, and nothing has here. It is kept because the next
       panel somebody floats over the picture is what it exists to catch,
       and said to be a guard so nobody reads it as proof. */
    ok('GUARD: the middle of the view is left clear', L.intruders.length===0, L.intruders);
    ok('the HUD column stays in the top corner',
       L.hudTL && L.hudTL.b < 390*0.55 && L.hudTL.w <= 230, L.hudTL);
    ok('the corner map is in the corner, not up the side',
       L.pod ? L.pod.b > 390*0.75 : true, L.pod);

    /* The dossier. A slab is the failure being fixed, so width is the
       property: it must take a side and leave the view. */
    ok('the dossier takes one side, not the whole screen',
       L.sheet && L.sheet.w < 844*0.6 && L.sheet.l > 844*0.35, L.sheet);
    ok('and runs the full height of it', L.sheet && L.sheet.h > 390*0.9, L.sheet);
    ok('its text sits at a readable width', L.paraW>0 && L.paraW<=560, L.paraW);
    ok('the dock steps out from under it',
       L.dockAfter && L.sheet && L.dockAfter.r <= L.sheet.l+1, {d:L.dockAfter,s:L.sheet});
    ok('CONTROL: and it had been centred before the panel opened',
       L.dockBefore && Math.abs((L.dockBefore.l+L.dockBefore.r)/2 - 422) < 12, L.dockBefore);
  }

  console.log('\nCONTROL: HELD UPRIGHT, NOTHING MOVED');
  const P=await look(390,844);
  {
    ok('SETUP: it really is the tall shape', P.vp[1]===844, P.vp);
    ok('CONTROL: the dossier is still a sheet across the foot',
       P.sheet && P.sheet.w > 390*0.9 && P.sheet.b >= 840, P.sheet);
    ok('CONTROL: the dock is still centred under it',
       P.dockAfter && Math.abs((P.dockAfter.l+P.dockAfter.r)/2 - 195) < 12, P.dockAfter);
    ok('GUARD: the middle is clear there too', P.intruders.length===0, P.intruders);
  }

  console.log('\nA SMALLER PHONE ON ITS SIDE');
  const S=await look(667,375);
  {
    ok('GUARD: the middle is clear at 667 too', S.intruders.length===0, S.intruders);
    ok('the dossier is still a column', S.sheet && S.sheet.w < 667*0.62, S.sheet);
    ok('and the dock still clears it',
       S.dockAfter && S.sheet && S.dockAfter.r <= S.sheet.l+1, {d:S.dockAfter,s:S.sheet});
  }

  ok('no page errors throughout', errs.length===0, errs);

  await b.close(); server.close();
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  process.exit(fail?1:0);
})();
