/* Talking to it.

   "hey vision" and then a question. It answers aloud and can change what is
   on screen while it does.

   Two things matter more than the answers themselves.

   THE WAKE WORD IS NOT A NETWORK CALL. While it is asleep every line it
   hears is compared against a phrase and thrown away. Nothing is sent
   anywhere until it has been woken.

   WHAT IT MAY DO IS A FIXED LIST. The model returns an action from a
   vocabulary this app defines. Anything it asks for that is not on that
   list is ignored, not guessed at - that is the difference between a model
   driving an interface and a model suggesting what it would like.        */
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
  await new Promise(r=>server.listen(0,r));
  const PORT=server.address().port;
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  const outbound=[]; page.on('request',r=>{ if(!r.url().includes('127.0.0.1:'+PORT)) outbound.push(r.url()); });

  await page.goto('http://127.0.0.1:'+PORT+'/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.VOICE&&window.GEM,null,{timeout:20000});

  console.log('\nTHE WAKE WORD');
  const wake = await page.evaluate(()=>{
    const seen=[];
    VOICE.on(e=>seen.push(e.kind));
    VOICE._heard('what time is it');                 // asleep: ignored
    const beforeAny = seen.slice();
    const asleepState = VOICE.state().awake;
    return { beforeAny, asleepState };
  });
  ok('a line heard while asleep does nothing', wake.beforeAny.length === 0, wake.beforeAny);
  ok('and it stays asleep', wake.asleepState === false, wake.asleepState);

  const phrases = await page.evaluate(()=>({
    hey:   VOICE.WAKE.test('hey vision what is that'),
    ok:    VOICE.WAKE.test('okay sightline'),
    plain: VOICE.WAKE.test('hi vision'),
    no1:   VOICE.WAKE.test('my television is broken'),
    no2:   VOICE.WAKE.test('I had a vision'),
    no3:   VOICE.WAKE.test('the revision is done')
  }));
  ok('"hey vision" wakes it', phrases.hey === true);
  ok('so do "okay sightline" and "hi vision"', phrases.ok && phrases.plain, phrases);
  ok('CONTROL: "television", "a vision" and "revision" do NOT', !phrases.no1 && !phrases.no2 && !phrases.no3, phrases);

  ok('nothing was sent anywhere while asleep', outbound.length === 0, outbound.slice(0,3));

  console.log('\nWHAT IT IS ALLOWED TO DO');
  const acts = await page.evaluate(()=>{
    const seen=[];
    VOICE.on(e=>seen.push(e));
    const n = VOICE._apply([
      { do:'box', what:'the bicycle', colour:'green' },
      { do:'only', what:'people' },
      { do:'clear' },
      { do:'deleteEverything' },            // not in the vocabulary
      { do:'fetch', url:'http://example.com' },
      { what:'no verb at all' },
      'not even an object'
    ]);
    return { applied: n, kinds: seen.map(e=>e.kind) };
  });
  ok('the allowed actions are carried out', acts.applied === 3, acts);
  ok('and they reach the display', acts.kinds.join(',') === 'box,only,clear', acts.kinds);
  ok('CONTROL: anything not in the vocabulary is ignored, not guessed at',
     acts.kinds.indexOf('deleteEverything') === -1 && acts.kinds.indexOf('fetch') === -1, acts.kinds);

  console.log('\nPOINTING AT THE RIGHT THING');
  const match = await page.evaluate(()=>{
    VOICE._apply([{ do:'box', what:'the bike' }]);
    const t = (cls,label)=>({cls, label});
    return {
      loose:   UI.voiceMatches(t('bicycle','')),
      exact:   UI.voiceMatches(t('bike','')),
      byLabel: UI.voiceMatches(t('thing','Brompton bike')),
      no:      UI.voiceMatches(t('chair','Herman Miller Aeron')),
      phrase:  UI.voiceMatches(t('bicycle','')),
      focus:   !!UI.voiceFocus()
    };
  });
  ok('"the bike" matches a bicycle', match.loose === true, match);
  ok('and matches by the name it was given too', match.byLabel === true, match);
  ok('CONTROL: it does not match a chair', match.no === false, match);
  ok('the instruction is live', match.focus === true, match.focus);

  const words = await page.evaluate(()=>{
    const t=(cls)=>({cls,label:''});
    const say=(w)=>{ VOICE._apply([{do:'box',what:w}]); };
    const out={};
    [['the telly','tv'],['my phone','cell phone'],['the sofa','couch'],
     ['that bin','trash can'],['the plant','potted plant'],['the red bike','bicycle'],
     ['people','person']].forEach(([said,cls])=>{ say(said); out[said]=UI.voiceMatches(t(cls)); });
    say('the telly'); out['__control_chair']=UI.voiceMatches(t('chair'));
    return out;
  });
  const spoken = Object.keys(words).filter(k=>k.indexOf('__')!==0);
  ok('the everyday word finds the class the detector knows',
     spoken.every(k=>words[k]===true), words);
  ok('CONTROL: and "the telly" still does not match a chair', words.__control_chair === false, words);

  console.log('\nGEMINI: THE QUICK ONE FIRST, THE OTHER WHEN IT IS FULL');
  const gem = await page.evaluate(()=>({
    primary: GEM.PRIMARY, fallback: GEM.FALLBACK,
    noKey: GEM.has(),
    rateLimited: GEM._turnedAway(429, ''),
    quota: GEM._turnedAway(403, 'Quota exceeded for this project'),
    missingModel: GEM._turnedAway(404, 'models/x is not found'),
    badKey: GEM._turnedAway(403, 'API key not valid'),
    serverDown: GEM._turnedAway(500, 'internal')
  }));
  ok('it asks 3.5 Flash Lite first', /3\.5-flash-lite$/.test(gem.primary), gem.primary);
  ok('and keeps 3.1 Flash Lite for when it is full', /3\.1-flash-lite$/.test(gem.fallback), gem.fallback);
  ok('a rate limit means try the other one', gem.rateLimited === true, gem.rateLimited);
  ok('so does an exhausted quota', gem.quota === true, gem.quota);
  ok('and a model this key cannot reach', gem.missingModel === true, gem.missingModel);
  ok('CONTROL: a bad key is NOT a reason to try the other model', gem.badKey === false, gem.badKey);
  ok('CONTROL: nor is the server being down', gem.serverDown === false, gem.serverDown);
  ok('with no key set it does not pretend to have one', gem.noKey === false, gem.noKey);

  const noKey = await page.evaluate(()=>GEM.ask('hello').then(r=>r));
  ok('and asking without one fails plainly', noKey.ok === false && /no key/.test(noKey.error), noKey);
  ok('still nothing sent anywhere', outbound.length === 0, outbound.slice(0,3));

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
