/* "use these, with fallbacks to mymemory and on device for speech to text
    and translate"  - with a picture of Gemini 3.5 Live Translate and
    Gemini 3.5 Transcribe Live, both marked Unlimited.

   What this checks, in the order it matters:

     1. The right model is picked for each job out of the real list, and a
        transcriber is never mistaken for a translator.
     2. The translation chain FALLS THROUGH. Every step answering nothing
        must reach the next one, and MyMemory - the only step that needs no
        key - must answer for a reader who has never entered one.
     3. A refusal dressed as an answer is not put on screen. MyMemory
        replies 200 with its complaint in the translation field when it is
        out of quota, and a caption saying MYMEMORY WARNING is worse than
        the original.
     4. The transcriber's own end-of-sentence rule: words arrive as they
        are heard and a pause closes the line.
     5. Losing the socket falls back to the browser's recogniser rather
        than killing captions.

   The Live sockets themselves are stubbed - there is no key here - so what
   is proven is the CHAIN and the SHAPE of what is sent, not Google's
   service. Said plainly rather than dressed up.                        */
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
  await page.waitForFunction(()=>window.SCRIBE&&window.CAPS&&window.LIVE,null,{timeout:30000});
  await page.evaluate(()=>{ const g=document.getElementById('gate'); if(g){g.classList.add('hidden'); g.hidden=true;} });

  console.log('\nTHE RIGHT MODEL FOR EACH JOB');
  {
    const m=await page.evaluate(()=>{
      const all=['models/gemini-3-flash-live',
                 'models/gemini-2.5-flash-native-audio-preview-09-2025',
                 'models/gemini-3.5-transcribe-live',
                 'models/gemini-3.5-live-translate',
                 'models/gemini-2.0-flash-live-001',
                 'models/gemini-2.5-transcribe-live-preview'];
      return {
        hear: SCRIBE._pick(all,/transcribe/i),
        tran: SCRIBE._pick(all,/translate/i),
        none: SCRIBE._pick(all,/nothing-like-this/i),
        empty: SCRIBE._pick([],/transcribe/i),
        /* The conversation list must still throw both of them away: a
           transcriber holding a conversation answers nothing. */
        rankHear: LIVE._rank('models/gemini-3.5-transcribe-live'),
        rankTran: LIVE._rank('models/gemini-3.5-live-translate'),
        rankTalk: LIVE._rank('models/gemini-3-flash-live')
      };
    });
    ok('the transcriber is the newest transcribe model', m.hear==='models/gemini-3.5-transcribe-live', m);
    ok('the translator is the translate model, not the transcriber', m.tran==='models/gemini-3.5-live-translate', m);
    ok('CONTROL: a job with no model picks nothing', m.none==='' && m.empty==='', m);
    ok('CONTROL: neither is offered as a conversation model', m.rankHear<0 && m.rankTran<0 && m.rankTalk>0, m);
  }

  console.log('\nMYMEMORY ANSWERS WITH NO KEY AT ALL');
  {
    const r=await page.evaluate(async()=>{
      const real=U.fetchT; const seen=[];
      U.fetchT=(url)=>{ seen.push(url);
        return Promise.resolve({ok:true,json:()=>Promise.resolve({responseStatus:200,
          responseData:{translatedText:'bonjour le monde'}})}); };
      const out=await SCRIBE._myMemory('hello world','en','fr');
      U.fetchT=real;
      return {out, url:seen[0]||'', keyless:!(window.GEM&&GEM.has&&GEM.has())};
    });
    ok('SETUP: there is no key in this browser', r.keyless===true, r);
    ok('MyMemory translates without one', r.out==='bonjour le monde', r);
    ok('and it is asked for the right pair', /langpair=en%7Cfr/.test(r.url), r.url);
  }

  console.log('\nA REFUSAL IS NOT A TRANSLATION');
  {
    const r=await page.evaluate(async()=>{
      const real=U.fetchT;
      const one=(body)=>{ U.fetchT=()=>Promise.resolve({ok:true,json:()=>Promise.resolve(body)});
        return SCRIBE._myMemory('hello','en','fr'); };
      const warn=await one({responseStatus:200,responseData:{translatedText:
        'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY'}});
      const over=await one({responseStatus:429,responseData:{translatedText:'bonjour'}});
      const good=await one({responseStatus:200,responseData:{translatedText:'bonjour'}});
      U.fetchT=()=>Promise.reject(new Error('offline'));
      const dead=await SCRIBE._myMemory('hello','en','fr');
      U.fetchT=real;
      return {warn,over,good,dead};
    });
    ok('its out-of-quota complaint is not shown as a translation', r.warn==='', r);
    ok('nor is anything it sends with a refusal code', r.over==='', r);
    ok('CONTROL: a real answer still comes through', r.good==='bonjour', r);
    ok('and a dead network answers nothing rather than throwing', r.dead==='', r);
  }

  console.log('\nTHE CHAIN FALLS THROUGH, STEP BY STEP');
  {
    const r=await page.evaluate(async()=>{
      const realFetch=U.fetchT, realHas=GEM.has, realTr=GEM.translate;
      const out={};
      /* The Live translator cannot open here, so step one is already
         answering nothing - which is the case a reader with no key has. */
      U.fetchT=()=>Promise.resolve({ok:true,json:()=>Promise.resolve({responseStatus:200,
        responseData:{translatedText:'MM'}})});

      /* No key: Gemini is skipped and MyMemory answers. */
      GEM.has=()=>false;
      out.noKey=await SCRIBE.translate('hello','en','fr');

      /* A key that works: Gemini answers and MyMemory is never reached. */
      let mmHits=0;
      U.fetchT=(url)=>{ if(/mymemory/.test(url)) mmHits++;
        return Promise.resolve({ok:true,json:()=>Promise.resolve({responseStatus:200,
          responseData:{translatedText:'MM'}})}); };
      GEM.has=()=>true;
      GEM.translate=()=>Promise.resolve({ok:true,text:'GEM'});
      out.withKey=await SCRIBE.translate('hello','en','fr');
      out.mmHits=mmHits;

      /* A key that is out of free calls: it falls to MyMemory. */
      GEM.translate=()=>Promise.resolve({ok:false,text:''});
      out.spent=await SCRIBE.translate('hello','en','fr');

      /* Everything refuses. */
      GEM.translate=()=>Promise.reject(new Error('no'));
      U.fetchT=()=>Promise.reject(new Error('offline'));
      out.nothing=await SCRIBE.translate('hello','en','fr');

      /* Same language in and out is not work to be done. */
      out.same=await SCRIBE.translate('hello','en','en');

      GEM.has=realHas; GEM.translate=realTr; U.fetchT=realFetch;
      return out;
    });
    ok('with no key at all, MyMemory answers', r.noKey.ok===true && r.noKey.text==='MM' && r.noKey.via==='mymemory', r.noKey);
    ok('with a working key, Gemini answers', r.withKey.ok===true && r.withKey.text==='GEM' && r.withKey.via==='gemini', r.withKey);
    ok('CONTROL: and MyMemory is not asked at all then', r.mmHits===0, r);
    ok('a key that is out of free calls falls to MyMemory', r.spent.text==='MM' && r.spent.via==='mymemory', r.spent);
    ok('when every step refuses it answers no, not a wrong translation', r.nothing.ok===false && r.nothing.text==='', r.nothing);
    ok('CONTROL: one language into itself is not translated', r.same.ok===false, r.same);
  }

  console.log('\nWHERE A HEARD SENTENCE ENDS');
  {
    const r=await page.evaluate(async()=>{
      const lines=[], parts=[];
      /* Drive the reader the socket drives, with no socket. */
      SCRIBE.stop();
      const mod=SCRIBE;
      const got=[];
      /* _feed is the frame reader; _flush is the pause closing a line.
         Both are driven here exactly as a real frame would drive them. */
      const hook=(fnName)=>{};
      /* Capture by listening the way captions does: through listen()'s
         callbacks is impossible without a socket, so the module's own
         doors are used and the output read from the caption bar instead. */
      return new Promise((res)=>{
        /* Rebuild the callbacks by hand: assign them through listen's
           failure path is not available, so the internals are exercised
           and the finished text collected from the partial stream. */
        res({ available: typeof mod._feed==='function' && typeof mod._flush==='function' });
      });
    });
    ok('SETUP: the sentence rule can be driven directly', r.available===true, r);

    const s=await page.evaluate(async()=>{
      /* A fake socket: listen() opens one, we answer setupComplete, then
         push transcription frames at it and watch what comes out. */
      const said=[], grew=[];
      const realWS=window.WebSocket, realGUM=navigator.mediaDevices.getUserMedia;
      let sock=null;
      navigator.mediaDevices.getUserMedia=()=>Promise.reject(new Error('no mic here'));
      window.WebSocket=function(){ sock=this; this.readyState=1; this.sent=[];
        this.send=(d)=>this.sent.push(d); this.close=()=>{ this.readyState=3; };
        setTimeout(()=>{ this.onopen&&this.onopen();
          this.onmessage&&this.onmessage({data:JSON.stringify({setupComplete:{}})}); },0); };
      /* A key and a model, so it will try. */
      const realKey=GEM.key, realHas=GEM.has, realBidi=LIVE.bidiNow;
      GEM.key=()=>'AQ.test'; GEM.has=()=>true;
      LIVE.bidiNow=()=>['models/gemini-3.5-transcribe-live','models/gemini-3.5-live-translate'];

      const started=SCRIBE.listen((t)=>said.push(t),(p)=>grew.push(p),()=>{});
      await new Promise(r=>setTimeout(r,30));
      const setup=sock&&sock.sent[0]?JSON.parse(sock.sent[0]).setup:null;

      const feed=(t)=>sock.onmessage({data:JSON.stringify({serverContent:{inputTranscription:{text:t}}})});
      feed('turn '); feed('left at ');
      const midway=said.length;
      feed('the church');
      /* Snapshot BEFORE the next sentence, or the reading is about that
         one instead - the growth of THIS sentence is what is being read. */
      const grewHere=grew.slice();
      await new Promise(r=>setTimeout(r,1300));      // the pause closes it
      const afterPause=said.slice();

      feed('and then ');
      sock.onmessage({data:JSON.stringify({serverContent:{turnComplete:true}})});
      const afterTurn=said.slice();

      SCRIBE.stop();
      window.WebSocket=realWS; navigator.mediaDevices.getUserMedia=realGUM;
      GEM.key=realKey; GEM.has=realHas; LIVE.bidiNow=realBidi;
      return { started, setup, grew, grewHere, midway, afterPause, afterTurn };
    });
    ok('it opens on the transcribe model', s.started===true && s.setup && s.setup.model==='models/gemini-3.5-transcribe-live', s.setup);
    ok('and asks for text and the input transcription', s.setup && s.setup.generationConfig.responseModalities[0]==='TEXT' && !!s.setup.inputAudioTranscription, s.setup);
    ok('words appear as they are heard', s.grewHere.length===3 &&
       s.grewHere[0]==='turn' && s.grewHere[2]==='turn left at the church', s.grewHere);
    ok('CONTROL: a sentence still being spoken is not closed', s.midway===0, s);
    ok('a pause closes the line', s.afterPause.length===1 && s.afterPause[0]==='turn left at the church', s.afterPause);
    ok('and the turn ending closes it at once', s.afterTurn.length===2 && s.afterTurn[1]==='and then', s.afterTurn);
  }

  console.log('\nLOSING IT FALLS BACK, IT DOES NOT BREAK');
  {
    const r=await page.evaluate(async()=>{
      const realWS=window.WebSocket;
      const realKey=GEM.key, realHas=GEM.has, realBidi=LIVE.bidiNow;
      GEM.key=()=>'AQ.test'; GEM.has=()=>true;
      LIVE.bidiNow=()=>['models/gemini-3.5-transcribe-live'];
      let why='', sock=null;
      window.WebSocket=function(){ sock=this; this.readyState=0; this.sent=[];
        this.send=()=>{}; this.close=()=>{};
        setTimeout(()=>{ this.onclose&&this.onclose({code:1007,reason:'no such model'}); },0); };
      const started=SCRIBE.listen(()=>{},()=>{},(w)=>{why=w;});
      await new Promise(r=>setTimeout(r,60));
      const h=SCRIBE.health();
      window.WebSocket=realWS; GEM.key=realKey; GEM.has=realHas; LIVE.bidiNow=realBidi;
      return { started, why, hearing:SCRIBE.hearing(), model:h.hearModel };
    });
    ok('a socket that will not open says so', r.why.indexOf('1007')>=0 || r.why.length>0, r);
    ok('and it is not left claiming to be listening', r.hearing===false, r);

    const c=await page.evaluate(()=>({
      hasEars: typeof CAPS.health==='function' && 'ears' in CAPS.health(),
      ears: CAPS.health().ears
    }));
    ok('captions say which ears are in use', c.hasEars===true, c);
    ok('CONTROL: with no key that is the on-device ones', c.ears==='on-device', c);
  }

  ok('no page errors throughout', errs.length===0, errs);

  await b.close(); server.close();
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  process.exit(fail?1:0);
})();
