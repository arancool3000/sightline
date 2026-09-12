/* Every panel in this app is positioned by an ID rule, and an ID rule beats
   the browser's own [hidden]{display:none}. So `el.hidden = true` was a
   no-op for six panels at once: the status strip stayed on screen as an
   empty black bar, and the scene chip sat over the AR cards.

   This walks every element the markup can hide and checks that hiding it
   actually hides it. A new panel with its own ID rule gets caught here
   rather than on the owner's phone.                                       */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=http.createServer((q,res)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('  ok   '+n);}else{fail++;console.log('  FAIL '+n+(x===undefined?'':'  '+JSON.stringify(x)));}};
(async()=>{
  await new Promise(r=>server.listen(8738,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  await page.goto('http://127.0.0.1:8738/',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(600);

  // Every id the markup ever hides, plus the panels shown by class.
  const ids=await page.evaluate(()=>Array.prototype.map.call(document.querySelectorAll('[id]'),e=>e.id));
  const hideable=['statusStrip','sceneChip','captionBar','sheet','settings','toast','wxCard','nearCard','mapPanel'];
  ok('SETUP: every panel under test exists in the page',hideable.every(i=>ids.indexOf(i)!==-1),
     hideable.filter(i=>ids.indexOf(i)===-1));

  for(const id of hideable){
    const r=await page.evaluate((id)=>{
      const el=document.getElementById(id);
      el.hidden=false;
      const shown=getComputedStyle(el).display;
      el.hidden=true;
      const hid=getComputedStyle(el).display;
      const box=el.getBoundingClientRect();
      el.hidden=true;
      return {shown:shown,hid:hid,w:box.width,h:box.height};
    },id);
    ok('#'+id+' is really hidden by .hidden = true',r.hid==='none',r);
    ok('CONTROL: #'+id+' is visible when it is not hidden',r.shown!=='none',r.shown);
    ok('CONTROL: and occupies nothing on screen once hidden',r.w===0&&r.h===0,{w:r.w,h:r.h});
  }

  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
