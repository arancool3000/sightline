/* "and it says mic blocked when it is not"

   Two errors used to end up at the same sentence and the same latch:

     not-allowed          the reader refused us  OR  something else holds
                          the one microphone this phone has - and this app
                          takes it twice itself, for the Live session and
                          for the transcriber
     service-not-allowed  the SPEECH SERVICE refused, which is not about
                          permission at all

   So the rule under test is: nothing may be called blocked until the
   question has actually been asked, and only a real refusal switches
   captions off. Everything else keeps the captions alive on whichever
   ears still work.

   The controls matter as much as the finding here. A build that simply
   deleted the message would pass "it does not say blocked" - so a REAL
   refusal must still say it, still switch off, and still toast.        */
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
  const ctx=await b.newContext({viewport:{width:844,height:390},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  await page.route('**/vendor/models/**',r=>r.abort());
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.CAPS&&window.UI,null,{timeout:30000});
  await page.evaluate(()=>{ const g=document.getElementById('gate'); if(g){g.classList.add('hidden'); g.hidden=true;} });

  /* One harness: stand a fake recogniser up, start captions, fire an
     error at it, and read what the app decided. `mic` says what the
     permission store and getUserMedia will answer. */
  const run = (error, mic) => page.evaluate(async ([error, mic]) => {
    const realSR=window.SpeechRecognition, realWSR=window.webkitSpeechRecognition;
    const realPerm=navigator.permissions, realGUM=navigator.mediaDevices.getUserMedia;
    const realToast=U.toast, realState=UI.captionState, realNote=UI.captionNote;
    const seen={toasts:[],states:[],notes:[]};
    U.toast=(t)=>seen.toasts.push(String(t));
    UI.captionState=(s)=>seen.states.push(s);
    UI.captionNote=(n)=>seen.notes.push(String(n));

    /* ⚠ The recogniser CANNOT be stubbed from out here: captions.js reads
       it from a binding captured when the file loaded, so window
       .SpeechRecognition is not what spin() constructs. The error handler
       is driven directly instead - which is why it was lifted out of
       spin() to begin with. */
    /* The permission store. 'none' means it cannot answer, which is
       Safari - then the microphone itself is the question. */
    if (mic.perm==='none') { try{ delete navigator.permissions; }catch(e){} }
    else Object.defineProperty(navigator,'permissions',{configurable:true,
      value:{ query:()=>Promise.resolve({state:mic.perm}) }});

    navigator.mediaDevices.getUserMedia = () => mic.open
      ? Promise.resolve({getTracks:()=>[{stop(){}}]})
      : Promise.reject(Object.assign(new Error('no'),{name:mic.err||'NotAllowedError'}));

    CAPS.stop();
    CAPS.start('captions');
    await new Promise(r=>setTimeout(r,40));
    const listening = CAPS.running();
    CAPS._recError({error:error});
    await new Promise(r=>setTimeout(r,400));
    const out = { listening, running: CAPS.running(), ears: CAPS.health().ears,
                  states: seen.states, notes: seen.notes, toasts: seen.toasts };
    CAPS.stop();
    window.SpeechRecognition=realSR; window.webkitSpeechRecognition=realWSR;
    Object.defineProperty(navigator,'permissions',{configurable:true,value:realPerm});
    navigator.mediaDevices.getUserMedia=realGUM;
    U.toast=realToast; UI.captionState=realState; UI.captionNote=realNote;
    return out;
  }, [error, mic]);

  const said = (r,re) => r.notes.some(n=>re.test(n)) || r.toasts.some(t=>re.test(t));

  console.log('\nTHE SPEECH SERVICE REFUSING IS NOT A BLOCKED MICROPHONE');
  {
    const r=await run('service-not-allowed',{perm:'granted',open:true});
    ok('SETUP: captions were really running first', r.listening===true, r);
    ok('it is not called blocked', !said(r,/BLOCKED/i), r);
    ok('and captions are not switched off', r.running===true, r);
    ok('the reader is not told to allow anything', r.toasts.length===0, r.toasts);
  }

  console.log('\nNOR IS SOMETHING ELSE HOLDING THE MICROPHONE');
  {
    /* not-allowed with permission granted: another consumer has it. */
    const r=await run('not-allowed',{perm:'granted',open:true});
    ok('it is not called blocked', !said(r,/BLOCKED/i), r);
    ok('and captions carry on', r.running===true, r);

    /* No permission store to ask, and the microphone opens: same answer,
       reached the other way. */
    const s=await run('not-allowed',{perm:'none',open:true});
    ok('with no permission store, opening the microphone is the answer', !said(s,/BLOCKED/i) && s.running===true, s);

    /* A microphone that is simply busy is somebody else's problem, not
       the reader's. */
    const t=await run('not-allowed',{perm:'prompt',open:false,err:'NotReadableError'});
    ok('a busy microphone is not a refusal either', !said(t,/BLOCKED/i) && t.running===true, t);
    ok('and it says what it actually is', said(t,/BUSY/i), t.notes);

    const u=await run('not-allowed',{perm:'prompt',open:false,err:'NotFoundError'});
    ok('a missing microphone says that instead', said(u,/NO MICROPHONE/i) && u.running===true, u.notes);
  }

  console.log('\nCONTROLS: A REAL REFUSAL STILL SAYS SO');
  {
    const r=await run('not-allowed',{perm:'denied',open:false});
    ok('CONTROL: a refusal in the permission store is called blocked', said(r,/BLOCKED/i), r);
    ok('CONTROL: and captions do switch off', r.running===false, r);
    ok('CONTROL: and the reader is told', r.toasts.some(t=>/permission/i.test(t)), r.toasts);

    /* No store to ask, and the microphone itself refuses. */
    const s=await run('not-allowed',{perm:'none',open:false,err:'NotAllowedError'});
    ok('CONTROL: the microphone refusing is also blocked', said(s,/BLOCKED/i) && s.running===false, s);
  }

  console.log('\nOTHER ERRORS ARE UNTOUCHED');
  {
    const r=await run('no-speech',{perm:'granted',open:true});
    ok('CONTROL: silence is not an error to report', !said(r,/BLOCKED/i) && r.running===true, r);
  }

  ok('no page errors throughout', errs.length===0, errs);

  await b.close(); server.close();
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  process.exit(fail?1:0);
})();
