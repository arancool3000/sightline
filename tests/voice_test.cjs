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

  /* ---- which keys are let through ----

     "gemini keys are sometimes AQ. and not AIza so sightline declines
      them."

     The check used to demand the AIza prefix, so a real key with any other
     prefix was refused by us before Google ever saw it. The rule now is
     "could this be a key", not "is this the prefix I know about" - the
     server decides whether it works. The controls are what stops that
     widening from accepting a pasted sentence or a URL. */
  const keys = await page.evaluate(() => ({
    aiza:    GEM.looksLikeKey('AIzaSyD-1234567890abcdefghijklmno'),
    aq:      GEM.looksLikeKey('AQ.Ab8RN6JxK2mPqR7tVwX9yZ1aB3cD4eF5gH6iJ7kL8mN9oP'),
    aqShort: GEM.looksLikeKey('AQ.abcdefghijklmnopqrstuvwxyz012345'),
    unknown: GEM.looksLikeKey('ZZ9-some_future.prefix1234567890'),
    empty:   GEM.looksLikeKey(''),
    tiny:    GEM.looksLikeKey('short'),
    url:     GEM.looksLikeKey('https://example.com/keys/abcdefghijklmnop'),
    words:   GEM.looksLikeKey('my key is AIzaSyD1234567890abcdef'),
    padded:  GEM.looksLikeKey('  AIzaSyD-1234567890abcdefghijklmno  ')
  }));
  ok('a key that starts AQ. is accepted', keys.aq === true && keys.aqShort === true, keys);
  ok('so is a prefix nobody here has heard of', keys.unknown === true, keys);
  ok('CONTROL: an AIza key still works', keys.aiza === true, keys);
  ok('CONTROL: nothing there is still nothing', keys.empty === false && keys.tiny === false, keys);
  ok('CONTROL: a pasted URL is not a key', keys.url === false, keys);
  ok('CONTROL: nor is a sentence with a key in it', keys.words === false, keys);
  ok('and stray spaces around a good key do not refuse it', keys.padded === true, keys);

  /* ---- the listening message has to survive the next frame ----

     "mic button listening popup dissapears almost immediately."

     statusFromEngine() runs inside draw(), twenty times a second, and once
     the recogniser is ready what it writes is EMPTY - so the listening
     message lived about forty milliseconds. What is checked is exactly
     that: wake it, then draw the frames that used to wipe it, and see
     whether it is still there. */
  const strip = await page.evaluate(async () => {
    const read = () => { const el = document.getElementById('statusStrip');
                         return { hidden: !!el.hidden,
                                  text: (document.getElementById('statusText')||{}).textContent || '' }; };
    VOICE.start();
    VOICE.wake();
    const atOnce = read();
    /* The frames that used to clear it. */
    for (let i = 0; i < 12; i++) { UI.draw([]); await new Promise(r => setTimeout(r, 30)); }
    const after = read();
    return { atOnce, after, awakeMs: VOICE.awakeMs() };
  });
  ok('SETUP: waking really does put the listening message up',
     /LISTENING/i.test(strip.atOnce.text) && strip.atOnce.hidden === false, strip.atOnce);
  ok('and it is still there after the frames that used to wipe it',
     /LISTENING/i.test(strip.after.text) && strip.after.hidden === false, strip.after);
  ok('SETUP: it is held for as long as it is really listening',
     strip.awakeMs > 1000, strip.awakeMs);

  /* CONTROL: a hold that never lets go would bury a real fault, so the
     strip has to come back to the engine when the window closes. */
  const back = await page.evaluate(async () => {
    VOICE.stop();
    UI.status ? UI.status('HELD', 'busy', 300) : null;
    await new Promise(r => setTimeout(r, 500));
    for (let i = 0; i < 4; i++) { UI.draw([]); await new Promise(r => setTimeout(r, 30)); }
    return (document.getElementById('statusText')||{}).textContent || '';
  });
  ok('CONTROL: once the hold lapses the strip is handed back',
     !/HELD/.test(back), back);

  /* ---- it stops listening by itself ----

     "the ai should automatically stop listening when it feels it is
      appropriate to." A plain answer ends the exchange; an answer that
      asks something back keeps the window open for a reply. */
  const done = await page.evaluate(() => {
    VOICE.start(); VOICE.wake();
    const before = VOICE.state().awake;
    VOICE._settle('The coffee shop is on your right.');
    const afterPlain = VOICE.state().awake;
    VOICE.wake();
    VOICE._settle('Would you like directions?');
    const afterAsk = VOICE.state().awake;
    VOICE.stop();
    return { before, afterPlain, afterAsk };
  });
  ok('SETUP: waking really makes it awake', done.before === true, done);
  ok('a plain answer closes the window by itself', done.afterPlain === false, done);
  ok('CONTROL: an answer that asks something back keeps it open for the reply', done.afterAsk === true, done);

  /* ---- a scene question gets the picture, not our labels ---- */
  const scene = await page.evaluate(async () => {
    const sent = [];
    const real = GEM.ask, realHas = GEM.has;
    GEM.has = () => true;
    GEM.ask = (prompt) => { sent.push(prompt); return Promise.resolve({ ok: true, text: '', model: 'stub',
      json: { say: 'A retriever and a red bike.', seen: [{ what: 'golden retriever', colour: 'green' }, { what: 'red bicycle' }] } }); };
    const boxes = [];
    VOICE.on(ev => { if (ev.kind === 'box') boxes.push(ev.what); });
    VOICE.start();
    await VOICE.ask('what am I looking at');
    await VOICE.ask('how far is the station');
    GEM.ask = real; GEM.has = realHas; VOICE.stop();
    return { sceneHadLabels: /already worked out/.test(sent[0] || ''), sceneAskedToLook: /name what YOU see/i.test(sent[0] || ''),
             factHadLabels: /already worked out/.test(sent[1] || ''), boxes,
             isScene: [VOICE.isSceneQuestion('what is that'), VOICE.isSceneQuestion('describe what you see'),
                       VOICE.isSceneQuestion('start a timer for ten minutes')] };
  });
  ok('a question about the scene is sent WITHOUT the app\'s labels', scene.sceneHadLabels === false, scene);
  ok('and the model is asked to name what it sees itself', scene.sceneAskedToLook === true, scene);
  ok('CONTROL: a question that is not about the scene still gets the context', scene.factHadLabels === true, scene);
  ok('what the model saw is boxed from its own answer',
     scene.boxes.indexOf('golden retriever') >= 0 && scene.boxes.indexOf('red bicycle') >= 0, scene.boxes);
  ok('SETUP: the scene test tells the two apart', scene.isScene[0] && scene.isScene[1] && !scene.isScene[2], scene.isScene);

  /* ---- the voice: Gemini first, the device when it cannot ---- */
  const tts = await page.evaluate(async () => {
    const realTts = GEM.tts, realHas = GEM.has;
    /* window.speechSynthesis is a read-only accessor in Chromium, so a
       stub assigned to it is silently dropped - the first cut counted 0
       device calls while the real engine was speaking. The utterance
       constructor IS writable, and one is made per device utterance. */
    let deviceCalls = 0;
    const realU = window.SpeechSynthesisUtterance;
    window.SpeechSynthesisUtterance = function (t) { deviceCalls++; this.text = t; };
    GEM.has = () => true;
    GEM.tts = () => Promise.resolve({ ok: true, pcm: new Int16Array(2400), rate: 24000 });
    const a = await VOICE.speak('hello');
    GEM.tts = () => Promise.resolve({ ok: false, error: 'speech is at its limit', turnedAway: true });
    const b = await VOICE.speak('hello again');
    GEM.has = () => false;
    const c = await VOICE.speak('and again');
    window.SpeechSynthesisUtterance = realU; GEM.tts = realTts; GEM.has = realHas;
    return { a, b, c, deviceCalls, models: GEM.TTS_MODELS };
  });
  ok('with a key and a working speech model, Gemini speaks', tts.a === 'gemini', tts);
  ok('at its limit, the device speaks instead', tts.b === 'device' && tts.deviceCalls >= 1, tts);
  ok('CONTROL: with no key at all, the device speaks', tts.c === 'device', tts);
  ok('SETUP: there is more than one speech model name to try', tts.models.length >= 2, tts.models);

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
