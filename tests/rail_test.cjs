const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=require('path').join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const s=http.createServer((q,res)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);if(!fs.existsSync(f)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
(async()=>{
  await new Promise(r=>s.listen(8722,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  let bad=0;
  for (const [w,h,name] of [[414,896,'iPhone 14'],[390,844,'iPhone 13'],[360,780,'small Android'],[768,1024,'tablet']]) {
    const ctx=await b.newContext({permissions:['camera'],viewport:{width:w,height:h}});
    const p=await ctx.newPage();
    await p.goto('http://localhost:8722/',{waitUntil:'domcontentloaded'});
    await p.waitForTimeout(900);
    await p.click('#btnStart'); await p.waitForTimeout(1500);
    const r=await p.evaluate(()=>{
      const strip=document.querySelector('.modes');
      const sr=strip.getBoundingClientRect();
      const btns=[...document.querySelectorAll('.mbtn')].map(b=>{
        const r=b.getBoundingClientRect();
        return {t:b.textContent.trim(), full: r.left>=sr.left-0.5 && r.right<=sr.right+0.5, h:Math.round(r.height)};
      });
      /* Only siblings IN THE RAIL can collide with the strip. The camera flip
         moved to the top HUD, so comparing it here asserted nothing about the
         rail and went red for a correct layout. */
      const cc=document.querySelector('#btnCaptions').getBoundingClientRect();
      const flip=document.querySelector('#btnFlip').getBoundingClientRect();
      return {btns, overflow: strip.scrollWidth>Math.ceil(sr.width),
              overlap: cc.left < sr.right-0.5 && cc.bottom > sr.top+0.5,
              flipReachable: flip.width>=36 && flip.height>=36 && flip.top>=0,
              touch: btns.every(x=>x.h>=44)};
    });
    const hidden=r.btns.filter(x=>!x.full).map(x=>x.t);
    const ok = hidden.length===0 && !r.overlap && r.touch && r.flipReachable;
    if(!ok) bad++;
    console.log((ok?'PASS  ':'FAIL  ')+name.padEnd(14)+w+'px   '+
      (hidden.length?'clipped: '+hidden.join(','):'all 5 fully visible')+
      (r.overlap?'   OVERLAPS BUTTONS':'')+(r.touch?'':'   TOUCH<44')+(r.flipReachable?'':'   FLIP UNREACHABLE'));
    await ctx.close();
  }
  await b.close();s.close();
  process.exit(bad?1:0);
})();
