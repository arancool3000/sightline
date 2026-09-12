/* Inline event handlers are dead code on this site: the CSP has no
   'unsafe-inline'. One shipped as a CLOSE button that rendered brighter than
   the working control and did nothing. This fails the build if another
   appears, and drives the real dossier to prove its close button works. */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};

const raw=fs.readFileSync(path.join(ROOT,'_headers'),'utf8').split('\n');
const rules=[]; let cur=null;
for(const line of raw){
  if(!line.trim()) continue;
  if(!/^\s/.test(line)){ cur={pattern:line.trim(),headers:[]}; rules.push(cur); continue; }
  if(cur){ const i=line.indexOf(':'); if(i>0) cur.headers.push([line.slice(0,i).trim(), line.slice(i+1).trim()]); }
}
const match=(pat,p)=>new RegExp('^'+pat.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*')+'$').test(p);

const server=http.createServer((q,res)=>{
  let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  const h={'Content-Type':MIME[path.extname(f)]||'application/octet-stream'};
  rules.forEach(r=>{ if(match(r.pattern,p)) r.headers.forEach(([k,v])=>{h[k]=v;}); });
  res.writeHead(200,h); res.end(fs.readFileSync(f));
});

(async()=>{
  const R=[]; const t=(n,c,x)=>R.push({n,p:!!c,x:x===undefined?'':String(x)});

  // static: no inline handler in any shipped script or the page
  const files=['index.html','js/ui.js','js/app.js','js/local.js','js/identify.js','js/captions.js','js/camera.js','js/track.js','js/wiki.js','js/settings.js','js/util.js'];
  const offenders=[];
  files.forEach(f=>{
    const src=fs.readFileSync(path.join(ROOT,f),'utf8');
    // an attribute assignment, not a property assignment or a comment
    const m=src.match(/\son(?:click|load|error|change|input|submit)\s*=\s*["'][^"']*["']/g);
    if(m) offenders.push(f+': '+m[0].trim().slice(0,50));
  });
  t('no inline event handlers anywhere', offenders.length===0, offenders.join(' | '));

  await new Promise(r=>server.listen(8761,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const ctx=await b.newContext({permissions:['camera'],viewport:{width:414,height:896}});
  const page=await ctx.newPage();
  const viol=[];
  page.on('console',m=>{ if(/Content Security Policy|Refused to/i.test(m.text())) viol.push(m.text().slice(0,140)); });

  await page.goto('http://localhost:8761/',{waitUntil:'domcontentloaded'});
  await page.click('#btnStart'); await page.waitForTimeout(2500);

  // drive the real dossier through its real close control
  const r = await page.evaluate(async () => {
    UI.openError('nothing-found');
    const open = !document.querySelector('#sheet').hidden;
    const closers = [...document.querySelectorAll('#sheet button')].map(b=>b.textContent.trim());
    document.querySelector('#sheetClose').click();
    await new Promise(z=>setTimeout(z,80));
    return { open, closers, closed: document.querySelector('#sheet').hidden };
  });
  t('the dossier opens', r.open === true);
  t('it offers exactly ONE close control', r.closers.length === 1, JSON.stringify(r.closers));
  t('that control actually closes it', r.closed === true, r.closed);
  t('no CSP violations while doing it', viol.length === 0, viol.slice(0,2).join(' | '));

  await b.close(); server.close();
  const bad=R.filter(x=>!x.p);
  R.forEach(x=>console.log((x.p?'PASS  ':'FAIL  ')+x.n+(x.x?'   ['+x.x+']':'')));
  console.log('\n'+(R.length-bad.length)+'/'+R.length+' passed');
  process.exit(bad.length?1:0);
})();
