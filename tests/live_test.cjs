/* "it should use gemini natural thingy that goes from speech to text" and
   "it should show captions as me and ai talk".

   The owner's own quota page is the reason this exists:

     Gemini 2.5 Flash Native Audio Dialog   Live API   0 / Unlimited
     Gemini 2.5 Flash TTS                              2 / 10 a DAY

   Ten a day is not a voice assistant. The Live socket is unlimited on the
   same key and carries the whole conversation - microphone up, speech
   back, and BOTH sides as text so they can go on screen.

   No socket is opened here. The frames are the contract, so the frames are
   what is fed in: a setup that must ask for both transcriptions, a turn
   that must reach the captions, and a spoken instruction that must go
   through the same command table a finger does - and no further.        */
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
    if(!u.startsWith(BASE)){ outbound.push(u.slice(0,80)); return r.abort(); }
    if(/\/vendor\/models\//.test(u)) return r.abort();
    return r.continue(); });
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.LIVE&&window.CMD&&window.UI&&window.MAP,null,{timeout:30000});
  await page.evaluate(()=>{ const g=document.getElementById('gate'); if(g){g.classList.add('hidden'); g.hidden=true;} });

  console.log('\nWHAT IT ASKS FOR WHEN IT CONNECTS');
  {
    const s=await page.evaluate(()=>({ models:LIVE.MODELS, brief:LIVE._brief() }));
    ok('SETUP: there is more than one live model name to try', s.models.length>=2, s.models);
    ok('every one is a models/ path', s.models.every(m=>/^models\//.test(m)), s.models);
    /* The captions are the reason both transcriptions are asked for; a
       build that forgets one is silent on that side of the conversation. */
    const src=await page.evaluate(()=>fetch('js/live.js').then(r=>r.text()));
    ok('it asks for a transcript of what YOU say', /inputAudioTranscription/.test(src));
    ok('and of what IT says', /outputAudioTranscription/.test(src));
    ok('it asks for audio back', /responseModalities:\s*\['AUDIO'\]/.test(src));
    ok('the microphone goes up as 16k PCM, which is the only shape it accepts',
       /UP_RATE\s*=\s*16000/.test(src) && /audio\/pcm;rate='\s*\+\s*UP_RATE/.test(src));
    ok('the brief tells it to answer in a sentence or two, not read a list',
       /ONE or TWO short spoken/.test(s.brief) && /Never read a list/.test(s.brief), s.brief.slice(0,60));
  }

  console.log('\nBOTH SIDES REACH THE CAPTIONS');
  {
    const cap=await page.evaluate(async()=>{
      const seen=[];
      LIVE.on(e=>seen.push(e.kind));
      LIVE._handle({serverContent:{inputTranscription:{text:'what am I looking at'}}});
      const you=document.getElementById('capMain').textContent;
      LIVE._handle({serverContent:{outputTranscription:{text:'A red bicycle against a wall.'}}});
      const it=document.getElementById('capMain').textContent;
      const bar=document.getElementById('captionBar');
      return { you, it, shown:!bar.hidden, seen, meta:document.getElementById('capMeta').textContent };
    });
    ok('your words appear as you say them', /what am I looking at/.test(cap.you), cap.you);
    ok('its answer appears under them', /red bicycle/.test(cap.it), cap.it);
    ok('and the bar is actually on screen', cap.shown===true, cap);
    ok('SETUP: both sides fired an event', cap.seen.indexOf('you')>=0 && cap.seen.indexOf('it')>=0, cap.seen);
  }

  console.log('\nWHAT IT SAYS IT WILL DO, IT DOES - THROUGH THE SAME TABLE');
  {
    const act=await page.evaluate(async()=>{
      MAP.setOpen(false);
      LIVE._act('The map is up now. [[do:show the map]]');
      const opened=MAP.isOpen();
      LIVE._act('Closing it. [[do:close the map]]');
      const closed=!MAP.isOpen();
      /* A verb outside the table must do nothing at all. */
      const before=MAP.isOpen();
      LIVE._act('[[do:format the disk]] [[do:send an email to bob]]');
      return { opened, closed, unchanged: MAP.isOpen()===before,
               spoken: LIVE._stripDo('That is a bicycle. [[do:box the bicycle]]') };
    });
    ok('a spoken instruction opens the map', act.opened===true, act);
    ok('and closes it', act.closed===true, act);
    ok('CONTROL: an instruction it invented does nothing', act.unchanged===true, act);
    ok('and the instruction is never read out loud', act.spoken==='That is a bicycle.', act.spoken);

    /* THE ONE THAT WOULD HAVE CAUGHT IT. Every instruction the brief tells
       the model to use must be one the command table actually answers to;
       the first cut invented a terse syntax and every instruction was
       silently dropped. Derived from the brief, so the two cannot drift. */
    const vocab=await page.evaluate(()=>{
      const brief=LIVE._brief();
      const words=(brief.match(/\[\[do:([^\]]+)\]\]/g)||[]).map(s=>s.slice(5,-2));
      return words.map(w=>({ w, known: !!CMD.match(w.replace(/THE PLACE/,'the station').replace(/the THING/,'the bicycle')) }));
    });
    ok('SETUP: the brief really lists some instructions', vocab.length>=8, vocab.length);
    ok('every instruction the brief offers is one the table understands',
       vocab.every(v=>v.known), vocab.filter(v=>!v.known).map(v=>v.w));
  }

  console.log('\nIT IS OFF UNTIL THERE IS A KEY');
  {
    const av=await page.evaluate(()=>{
      const real=GEM.has; GEM.has=()=>false; const off=LIVE.available();
      GEM.has=()=>true; const on=LIVE.available();
      GEM.has=real; return { off, on, running:LIVE.running() };
    });
    ok('with no key there is no live session', av.off===false, av);
    ok('CONTROL: with a key it is available', av.on===true, av);
    ok('and nothing has connected on its own', av.running===false, av);
    /* The detector fetching its weights from Google is the detector, not
       this module. What must not happen is a live socket opening itself. */
    const live=outbound.filter(u=>/generativelanguage/.test(u));
    ok('no live connection was made without being asked', live.length===0, live);
    ok('SETUP: the probe really was watching the network', outbound.length>0, outbound.length);
  }

  console.log('\nCONNECTED IS NOT WORKING');
  {
    /* "no sound coming, it isn't responding to live messages." A socket
       that opens and then says nothing leaves the assistant deaf AND
       mute, because the live session has taken the microphone. */
    const s=await page.evaluate(()=>({ why: LIVE.why(), st: LIVE.state(), models: LIVE.MODELS }));
    ok('with no key it says so rather than looking broken', /no gemini key/i.test(s.why), s.why);
    ok('SETUP: several model names are tried, because the ids move', s.models.length>=3, s.models.length);

    const src=await page.evaluate(()=>fetch('js/live.js').then(r=>r.text()));
    /* An AudioContext starts SUSPENDED and a suspended one plays nothing
       while reporting no error - which is exactly "no sound coming". */
    ok('the audio context is resumed, not just created', /state === 'suspended'[\s\S]{0,40}resume\(\)/.test(src));
    ok('and it is created inside the tap, where a browser will allow it',
       /function start\(\)[\s\S]{0,900}audio\(\);/.test(src));
    ok('a session that never answers is closed rather than left holding the microphone',
       /PROVE_MS/.test(src) && /never answered/.test(src));
    ok('the model that worked is remembered for next time', /localStorage\.setItem\(REMEMBER/.test(src));

    const said=await page.evaluate(()=>{
      const real=GEM.has; GEM.has=()=>true;
      const a=LIVE.why();
      GEM.has=real; return a;
    });
    ok('CONTROL: with a key and nothing connected it says that instead', /idle|would connect/i.test(said), said);
  }

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close(); server.close(); process.exit(fail?1:0);
})().catch(e=>{ console.log('  FAIL the suite could not finish  '+JSON.stringify(String(e&&e.message||e).split('\n')[0]));
  console.log('\n'+pass+'/'+(pass+fail+1)+' passed'); process.exit(1); });
