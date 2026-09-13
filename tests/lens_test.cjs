/* "add live translation from camera like google translate camera mode
    where it overlays in same/similar colour text translated over the
    different language text."

   The translation is the easy half. What makes it feel like the sign is
   simply in your language is that the words SIT WHERE THE OLD WORDS WERE,
   in roughly their colour - so this suite is mostly about boxes and
   colour, not about language.

   No network: the model's answer is fed in as a frame, because what is
   being checked is what we do with it.                                  */
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
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  const outbound=[];
  await page.route('**/*', r=>{ const u=r.request().url();
    if(!u.startsWith(BASE)){ outbound.push(u.slice(0,70)); return r.abort(); }
    if(/\/vendor\/models\//.test(u)) return r.abort();
    return r.continue(); });
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.LENS&&window.CMD&&window.UI,null,{timeout:30000});
  await page.evaluate(()=>{ const g=document.getElementById('gate'); if(g){g.classList.add('hidden'); g.hidden=true;} });

  console.log('\nWHAT IT ASKS FOR');
  {
    const s=await page.evaluate(()=>fetch('js/lens.js').then(r=>r.text()));
    ok('it asks for the box as fractions, so it works at any size', /FRACTIONS of the image from 0 to 1/.test(s));
    ok('it asks for one block per line, not one for the whole sign', /One block per line or short phrase/.test(s));
    ok('and it is told to leave out what it cannot read', /too blurred to be sure of/.test(s));
    ok('it paces itself - a sign does not move', /EVERY_MS = \d{4}/.test(s));
  }

  console.log('\nWHAT IS WORTH DRAWING');
  {
    const c=await page.evaluate(()=>({
      good:   !!LENS._clean({text:'Salida', out:'Exit', box:[0.1,0.2,0.3,0.05]}),
      same:   !!LENS._clean({text:'Hotel',  out:'hotel', box:[0.1,0.2,0.3,0.05]}),
      empty:  !!LENS._clean({text:'Salida', out:'',     box:[0.1,0.2,0.3,0.05]}),
      nobox:  !!LENS._clean({text:'Salida', out:'Exit', box:[0.1,0.2]}),
      tiny:   !!LENS._clean({text:'x',      out:'y',    box:[0.1,0.2,0.001,0.001]}),
      offside:!!LENS._clean({text:'Salida', out:'Exit', box:[1.4,0.2,0.3,0.05]}),
      clipped: LENS._clean({text:'Salida', out:'Exit', box:[0.8,0.2,0.9,0.05]}).box
    }));
    ok('a real translation is drawn', c.good===true, c);
    /* Covering a word with the same word is vandalism, not translation. */
    ok('CONTROL: a "translation" that is the same word is not drawn', c.same===false, c);
    ok('CONTROL: nor is an empty one', c.empty===false, c);
    ok('CONTROL: nor one with nowhere to go', c.nobox===false && c.offside===false, c);
    ok('CONTROL: nor one too small to read', c.tiny===false, c);
    ok('a box running off the edge is clipped to the frame',
       c.clipped[0]+c.clipped[2] <= 1.0001, c.clipped);
  }

  console.log('\nIT IS OFF UNTIL ASKED, AND NEEDS A KEY');
  {
    const s=await page.evaluate(()=>{
      const realHas=GEM.has;
      GEM.has=()=>false;
      const noKey=LENS.start(), why=LENS.state().error;
      GEM.has=()=>true;
      const withKey=LENS.start(), running=LENS.running();
      LENS.stop();
      GEM.has=realHas;
      return { noKey, why, withKey, running, after:LENS.running() };
    });
    ok('with no key it refuses and says why', s.noKey===false && /Gemini key/.test(s.why), s);
    ok('CONTROL: with a key it starts', s.withKey===true && s.running===true, s);
    ok('and stops when told', s.after===false, s);
    ok('nothing was sent anywhere', outbound.filter(u=>/generativelanguage/.test(u)).length===0, outbound.slice(0,3));
  }

  console.log('\nSAYING IT');
  {
    const v=await page.evaluate(()=>({
      sign: (CMD.match('translate this sign')||{}).name,
      menu: (CMD.match('translate the menu')||{}).name,
      bare: (CMD.match('translate')||{}).name,
      off:  (CMD.match('stop translating')||{}).name,
      notThis: !!CMD.match('what does that sign say about opening hours on sundays')
    }));
    ok('"translate this sign" is a built-in', v.sign==='translate view', v);
    ok('so are "translate the menu" and bare "translate"',
       v.menu==='translate view' && v.bare==='translate view', v);
    ok('and it can be turned off', v.off==='stop translating', v);
    ok('CONTROL: a long question about a sign still goes to the model', v.notThis===false, v);
  }

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close(); server.close(); process.exit(fail?1:0);
})().catch(e=>{ console.log('  FAIL the suite could not finish  '+JSON.stringify(String(e&&e.message||e).split('\n')[0]));
  console.log('\n'+pass+'/'+(pass+fail+1)+' passed'); process.exit(1); });
