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

    /* THE ONE THAT WOULD HAVE CAUGHT IT. Every tool must map to words the
       command table actually answers to - the first cut invented a terse
       [[do:map open]] syntax nothing understood, so every instruction was
       silently dropped. Derived from the tool table, so they cannot drift.
       identify is exempt: it is answered here, not by the table. */
    const vocab=await page.evaluate(()=>LIVE.TOOLS.filter(t=>t.say.charAt(0)!=='\u0000').map(t=>{
      const phrase = t.arg ? (t.say + (t.arg==='place' ? 'the station' : 'bicycle')) : t.say;
      return { name:t.name, phrase, known: !!CMD.match(phrase) };
    }));
    ok('SETUP: there are tools to check', vocab.length>=8, vocab.length);
    ok('every tool maps to words the command table understands',
       vocab.every(v=>v.known), vocab.filter(v=>!v.known));
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
    /* "do 3 flash then for audio instead of 2.5 flash." */
    ok('the newest full-dialog model is the one asked for first',
       /gemini-3-flash-live/.test(s.models[0]), s.models[0]);
    ok('and 2.5 native audio is behind it, not in front',
       s.models.findIndex(m=>/2\.5/.test(m)) > 0, s.models);
    /* The specialists are unlimited too and would look like a working
       assistant that ignores every instruction. */
    ok('CONTROL: no translate-only or transcribe-only model is in the list',
       !s.models.some(m=>/translate|transcribe/i.test(m)), s.models);

    /* THE ONE THAT WOULD HAVE UNDONE IT. Remembering what connected last
       time must never outrank the preferred model, or the choice gets
       made once - on whichever day the newest happened to be down. */
    const pinned=await page.evaluate(async()=>{
      try { localStorage.setItem('sightline.live.model.v2','models/gemini-2.0-flash-live-001'); } catch(e){}
      const realWS=window.WebSocket, realHas=GEM.has, realKey=GEM.key;
      GEM.has=()=>true; GEM.key=()=>'AIzaTESTTESTTESTTESTTEST';
      /* A socket that never opens, so start() lays out its order and waits. */
      window.WebSocket=function(){ this.close=function(){}; };
      /* start() asks the API which models exist before it lays out its
         order, so it is a promise now - reading _order() synchronously
         after it read an empty list. */
      LIVE.start();
      await new Promise(r=>setTimeout(r,400));
      const order=LIVE._order();
      window.WebSocket=realWS; GEM.has=realHas; GEM.key=realKey; LIVE.stop();
      try { localStorage.removeItem('sightline.live.model.v2'); } catch(e){}
      return order;
    });
    ok('even with an older model remembered, the newest is still tried first',
       /gemini-3-flash-live/.test(pinned[0]||''), pinned);
    ok('and the remembered one is second, so a known-good name is not walked to',
       /2\.0-flash-live/.test(pinned[1]||''), pinned);

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

  console.log('\nTHE SOUND ACTUALLY COMES OUT');
  {
    /* "it works now but no volume." The ScriptProcessor that carries the
       microphone was sinking into ac.destination - the MICROPHONE into
       the SPEAKER - so the browser's own echo canceller had a feedback
       loop and did its job on everything, the model's voice included. */
    const src=await page.evaluate(()=>fetch('js/live.js').then(r=>r.text()));
    ok('the microphone is NOT wired to the speaker',
       !/node\.connect\(ac\.destination\)/.test(src));
    ok('it sinks into a silent gain instead, so the node still runs',
       /sink\.gain\.value = 0/.test(src) && /node\.connect\(sink\)/.test(src));
    ok('every audible thing goes through one output gain',
       /out = ac\.createGain\(\)/.test(src) && /out\.gain\.value = 1/.test(src));
    ok('and iOS is unlocked with an empty buffer from the gesture',
       /createBuffer\(1, 1, 22050\)/.test(src));

    /* A turn with words and no sound must not simply be silent. */
    const mute=await page.evaluate(()=>{
      const seen=[];
      LIVE.on(e=>{ if(e.kind==='mute'||e.kind==='turn') seen.push(e.kind+':'+(e.text||e.it||'')); });
      LIVE._handle({serverContent:{outputTranscription:{text:'The bus is due in four minutes.'}}});
      LIVE._handle({serverContent:{turnComplete:true}});
      return seen;
    });
    /* The caption block above left its turn open on purpose, so the
       transcript here carries both sentences - which is right for a
       stream. What matters is that the words reached the device. */
    ok('an answer that made no sound is handed to the device to read',
       mute.some(s=>s.indexOf('mute:')===0 && /bus is due in four minutes/.test(s)), mute);
    ok('SETUP: and the turn still completes normally', mute.some(s=>/^turn:/.test(s)), mute);
  }

  console.log('\nIT ASKS WHICH MODELS EXIST INSTEAD OF GUESSING');
  {
    /* The screenshot: "Connected to gemini-2.5-flash-native-audio-preview
       -09-2025 but it has not answered yet" - it had fallen through to the
       THIRD guess, so the first two names were wrong. ListModels says
       which are real, and the live ones are exactly those carrying
       bidiGenerateContent. */
    const d=await page.evaluate(async()=>{
      const realHas=GEM.has, realKey=GEM.key, realFetch=window.U.fetchT;
      GEM.has=()=>true; GEM.key=()=>'AIzaTESTTESTTESTTESTTEST';
      let asked='';
      window.U.fetchT=(u)=>{ asked=u; return Promise.resolve({ ok:true, json:()=>Promise.resolve({ models:[
        { name:'models/gemini-2.0-flash-live-001', supportedGenerationMethods:['bidiGenerateContent'] },
        { name:'models/gemini-3-flash-live-preview', supportedGenerationMethods:['bidiGenerateContent'] },
        { name:'models/gemini-3.5-transcribe-live', supportedGenerationMethods:['bidiGenerateContent'] },
        { name:'models/gemini-2.5-flash-native-audio-preview-09-2025', supportedGenerationMethods:['bidiGenerateContent'] },
        { name:'models/gemini-3.5-flash', supportedGenerationMethods:['generateContent'] }
      ] }) }); };
      const live=await LIVE._discover();
      GEM.has=realHas; GEM.key=realKey; window.U.fetchT=realFetch;
      return { live, asked, ranks:{ dialog:LIVE._rank('models/gemini-3-flash-live-preview'),
                                    old:LIVE._rank('models/gemini-2.0-flash-live-001'),
                                    trans:LIVE._rank('models/gemini-3.5-transcribe-live') } };
    });
    ok('it asks the API for the model list', /\/v1beta\/models\?/.test(d.asked), d.asked.slice(0,60));
    ok('only models that can hold a live session come back',
       d.live.every(n=>/live|native-audio/.test(n)) && d.live.indexOf('models/gemini-3.5-flash')<0, d.live);
    ok('a text-only model is not offered', !d.live.some(n=>n==='models/gemini-3.5-flash'), d.live);
    ok('CONTROL: transcribe-only is ranked out, whatever bidi says it can do',
       d.ranks.trans < 0 && d.live.indexOf('models/gemini-3.5-transcribe-live')<0, d);
    ok('and the newest dialog model comes first', /gemini-3-flash-live/.test(d.live[0]||''), d.live);
    ok('SETUP: the ranking really does separate them', d.ranks.dialog > d.ranks.old, d.ranks);
  }

  console.log('\nCONNECTED, SET UP, AND SILENT');
  {
    /* From here, "the server ignores the field I sent" and "nobody is
       speaking" look identical. So a whole session with no reply at all
       flips to the other shape for next time. */
    const f=await page.evaluate(()=>{
      const before=LIVE._legacy();
      LIVE._flip();
      const after=LIVE._legacy();
      LIVE._flip();
      return { before, after, back:LIVE._legacy() };
    });
    ok('the audio field has two shapes and it can swap between them',
       f.before !== f.after && f.back === f.before, f);
    const src=await page.evaluate(()=>fetch('js/live.js').then(r=>r.text()));
    ok('the modern shape is the default', /realtimeInput: \{ audio: chunk \}/.test(src));
    ok('and a silent session flips it rather than giving up', /flipAudioShape\(\);\n\s*err = 'the live voice connected but never answered/.test(src));
    ok('it says hello on connecting, so the whole path proves itself',
       /say\('Say only: ready\.'\)/.test(src));
  }

  console.log('\nIT WATCHES RATHER THAN GLANCES');
  {
    const w=await page.evaluate(()=>({ ms: LIVE.FRAME_MS,
      src: null }));
    const src=await page.evaluate(()=>fetch('js/live.js').then(r=>r.text()));
    ok('a frame goes up about once a second', w.ms >= 500 && w.ms <= 2000, w.ms);
    /* 258 tokens a frame at 1fps is ~15,500 a minute against 65,000. */
    ok('which is a quarter of the token budget, not all of it',
       (60000 / w.ms) * 258 < 65000 * 0.35, Math.round((60000 / w.ms) * 258));
    ok('it stops looking when the session closes', /clearInterval\(frameTimer\); frameTimer = 0;/.test(src));
    ok('and does not send frames while the page is hidden', /document\.hidden\) return;/.test(src));
  }

  console.log('\nIT HAS TOOLS, AND DOES NOT READ THEM OUT LOUD');
  {
    /* "it doesn't know its tool calls. it literally just did [[do:box the
        rubiks cube]] when i told it to draw a box around the rubiks
        cube." A native-audio model SPEAKS everything it produces, so a
        text marker gets read aloud. Declared tools come back as toolCall
        frames, which are not part of what it says. */
    const d=await page.evaluate(()=>({ decls: LIVE._declarations(), brief: LIVE._brief(),
                                       phrase: LIVE._phraseFor('box',{thing:'rubiks cube'}) }));
    ok('the tools are declared to the model', d.decls.length>=8, d.decls.length);
    ok('every one has a name and a description a model can act on',
       d.decls.every(x=>x.name && x.description && x.description.length>25), d.decls.slice(0,2));
    ok('the ones that take a thing declare the argument',
       (d.decls.find(x=>x.name==='box')||{}).parameters !== undefined, d.decls.find(x=>x.name==='box'));
    ok('the brief tells it never to say an instruction out loud',
       /Never say a tool name or an instruction out loud/.test(d.brief), d.brief.slice(0,50));
    ok('and the bracket syntax is gone from the brief', !/\[\[do:/.test(d.brief), d.brief.slice(0,80));
    ok('a tool call becomes words the command table understands',
       d.phrase==='box the rubiks cube', d.phrase);

    /* End to end: a toolCall frame must actually box something. */
    const boxed=await page.evaluate(async()=>{
      const seen=[]; CMD.on(e=>seen.push(e.kind+':'+(e.what||'')));
      LIVE._toolCall({ toolCall:{ functionCalls:[{ id:'c1', name:'box', args:{ thing:'rubiks cube' } }] } });
      await new Promise(r=>setTimeout(r,100));
      return seen;
    });
    ok('a toolCall for box really fires a box', boxed.some(s=>/^box:rubiks cube/.test(s)), boxed);
  }

  console.log('\nAND IT ASKS THE BETTER MODEL WHEN IT IS NOT SURE');
  {
    /* "i ask it what 3d printer it is looking at, and it tells me my v3
        plus is from prusa... but when i tap it identification was
        actually correct." */
    const esc=await page.evaluate(async()=>{
      const realTap=IDENT.tapAsk;
      let asked=false;
      IDENT.tapAsk=()=>{ asked=true; return Promise.resolve({ name:'Creality Ender-3 V3 Plus',
        specs:[{k:'Manufacturer',v:'Creality'}] }); };
      TRACK.reset();
      TRACK.update([{cls:'tv', box:[10,10,200,200], score:0.9}], performance.now());
      let sent=null; const answers=[];
      LIVE.on(e=>{ if(e.kind==='tool') answers.push(e); });
      LIVE._toolCall({ toolCall:{ functionCalls:[{ id:'i1', name:'identify', args:{} }] } });
      await new Promise(r=>setTimeout(r,300));
      IDENT.tapAsk=realTap;
      return { asked, answers };
    });
    ok('identify goes to the model that gets it right', esc.asked===true, esc.asked);
    ok('and the exact name comes back for it to say',
       /Ender-3 V3 Plus/.test((esc.answers[0]||{}).answer||''), esc.answers);
    ok('CONTROL: it is reported as a tool, not spoken as text',
       (esc.answers[0]||{}).name==='identify', esc.answers);
  }

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close(); server.close(); process.exit(fail?1:0);
})().catch(e=>{ console.log('  FAIL the suite could not finish  '+JSON.stringify(String(e&&e.message||e).split('\n')[0]));
  console.log('\n'+pass+'/'+(pass+fail+1)+' passed'); process.exit(1); });
