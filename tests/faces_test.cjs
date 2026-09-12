/* Remembering a face you have met.

   A memory aid for names you cannot place. What matters here is not only
   that it recognises people, but the three promises around it:

     it is OFF until switched on,
     nothing about a face ever leaves the device,
     and one tap forgets a person, one tap forgets everyone.

   The matching is driven with descriptors rather than photographs on
   purpose: what is under test is the threshold and the address book, and
   the cost of being wrong about which of two people is in front of you.  */
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
  await new Promise(r=>server.listen(8750,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));

  /* Anything that leaves the device would show up here. */
  const outbound=[];
  page.on('request',r=>{ const u=r.url(); if(!/127\.0\.0\.1:8750/.test(u)) outbound.push(u); });

  await page.goto('http://127.0.0.1:8750/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.FACES,null,{timeout:20000});

  console.log('\nIT IS OFF UNTIL ASKED FOR');
  let r = await page.evaluate(()=>FACES.state());
  ok('face memory starts off', r.on === false, r);
  ok('and nothing has been loaded', r.ready === false && r.loading === false, r);
  ok('the library was not fetched at boot',
     (await page.evaluate(()=>performance.getEntriesByType('resource')
        .filter(e=>/face-api|models\/faces/.test(e.name)).length)) === 0);

  console.log('\nREMEMBERING SOMEBODY');
  const book = await page.evaluate(()=>{
    /* Two people, and the same person again in a different light. */
    const mk = (seed)=>{ const d=[]; let x=seed;
      for(let i=0;i<128;i++){ x=(x*1103515245+12345)%2147483647; d.push((x/2147483647)-0.5); }
      return d; };
    const jitter = (d, amt)=>d.map(v=>v+(Math.random()-0.5)*amt);

    const ana = mk(11), ben = mk(9999);
    FACES.wipe();
    const p = FACES.remember(ana, 'Ana');
    return {
      saved: !!p, name: p && p.name, known: FACES.all().length,
      /* The same face again, slightly different - should be her. */
      again: FACES.match(jitter(ana, 0.02)),
      /* A different person entirely - must NOT be her. */
      other: FACES.match(ben),
      /* An empty name is not a person. */
      noName: FACES.remember(ana, '   '),
      anaD: ana, benD: ben
    };
  });
  ok('a face can be given a name', book.saved && book.name === 'Ana', book.name);
  ok('and there is one person in the book', book.known === 1, book.known);
  ok('the same face again is recognised', !!book.again && book.again.person.name === 'Ana', book.again && book.again.person.name);
  ok('CONTROL: a different person is NOT recognised as her', book.other === null, book.other);
  ok('a blank name saves nobody', book.noName === null, book.noName);

  console.log('\nTHE COST OF THE TWO MISTAKES IS NOT EQUAL');
  const bar = await page.evaluate(([ana])=>{
    const drift = (d, amt)=>d.map((v,i)=>v + (i%2?amt:-amt));
    return {
      threshold: FACES.MATCH,
      near: FACES.match(drift(ana, 0.02)) ? 'matched' : 'refused',
      far:  FACES.match(drift(ana, 0.09)) ? 'matched' : 'refused'
    };
  },[book.anaD]);
  ok('the bar is stricter than the library default of 0.6', bar.threshold < 0.55, bar.threshold);
  ok('a small change in lighting still recognises her', bar.near === 'matched', bar.near);
  ok('a face that has drifted well away is refused rather than guessed', bar.far === 'refused', bar.far);

  console.log('\nCORRECTING A NAME');
  const fixed = await page.evaluate(([ana])=>{
    const jitter = (d)=>d.map(v=>v+(Math.random()-0.5)*0.02);
    FACES.remember(jitter(ana), 'Ana Silva');       // same face, fuller name
    const all = FACES.all();
    return { count: all.length, name: all[0] && all[0].name };
  },[book.anaD]);
  ok('naming a known face corrects it rather than adding a second', fixed.count === 1, fixed.count);
  ok('and the new name is kept', fixed.name === 'Ana Silva', fixed.name);

  console.log('\nFORGETTING');
  const gone = await page.evaluate(([ben])=>{
    FACES.remember(ben, 'Ben');
    const before = FACES.all().length;
    const id = FACES.all().filter(p=>p.name==='Ben')[0].id;
    FACES.forget(id);
    const after = FACES.all().length;
    FACES.wipe();
    return { before, after, wiped: FACES.all().length,
             stored: localStorage.getItem('sightline.faces.v1') };
  },[book.benD]);
  ok('SETUP: there were two people', gone.before === 2, gone.before);
  ok('one tap forgets one person', gone.after === 1, gone.after);
  ok('and one tap forgets everyone', gone.wiped === 0, gone.wiped);
  ok('with nothing left behind in storage', gone.stored === '[]', gone.stored);

  console.log('\nNOTHING LEAVES THE DEVICE');
  ok('no request went anywhere but this origin', outbound.length === 0, outbound.slice(0,4));
  const shape = await page.evaluate(()=>{
    const mk=(s)=>{const d=[];let x=s;for(let i=0;i<128;i++){x=(x*1103515245+12345)%2147483647;d.push((x/2147483647)-0.5);}return d;};
    FACES.remember(mk(5),'Test');
    const raw = JSON.parse(localStorage.getItem('sightline.faces.v1'));
    FACES.wipe();
    return { keys: Object.keys(raw[0]).sort(), len: raw[0].d.length };
  });
  ok('what is stored is 128 numbers and a name', shape.len === 128, shape.len);
  ok('and no image of anybody', shape.keys.indexOf('image') === -1 && shape.keys.indexOf('photo') === -1, shape.keys);

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
