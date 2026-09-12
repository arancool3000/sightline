/* What the app is willing to claim.

   "always making mistakes, always pointing out the obvious, always acting
    dumb."

   All three are one fault: a classifier asked about a single frame always
   returns its best of a thousand classes, cannot answer "I do not know",
   and had that written up as a fact. This is the judge that stands between
   a guess and the screen.

   Every case below is one of the owner's actual reports, put to it.       */
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
  await new Promise(r=>server.listen(8749,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  await page.goto('http://127.0.0.1:8749/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.EVIDENCE,null,{timeout:20000});

  /* Feeds a run of looks at one thing and asks what may be claimed. */
  const run = (cls, looks) => page.evaluate(([cls,looks])=>{
    const t = { cls };
    let now = 1000;
    looks.forEach(l=>{ EVIDENCE.record(t, l[0], l[1], l[2], now); now += 300; });
    return { v: EVIDENCE.verdict(t, now), ev: Object.keys(t.ev) };
  },[cls,looks]);

  console.log('\nONE LOOK IS NOT AN ANSWER');
  let r = await run('dog', [['Cocker Spaniel', 0.52, 0.2]]);
  ok('a single middling look is not ready', r.v && r.v.ready === false, r.v);
  ok('and it says it is still looking', r.v && r.v.why === 'looking again', r.v && r.v.why);

  r = await run('dog', [['Cocker Spaniel', 0.52, 0.2], ['Cocker Spaniel', 0.55, 0.24]]);
  ok('CONTROL: the same answer twice IS ready', r.v && r.v.ready === true, r.v);

  console.log('\nTHE MALTIPOO');
  /* A crossbreed: the model is torn between neighbours every single time,
     and each individual look looks respectable. */
  r = await run('dog', [
    ['Cocker Spaniel', 0.31, 0.04],
    ['Toy Poodle',     0.29, 0.03],
    ['Maltese',        0.27, 0.02],
    ['Cocker Spaniel', 0.30, 0.03]
  ]);
  ok('a crossbreed is never claimed as a breed', r.v && r.v.ready === false, r.v);
  ok('and the reason given is that it is torn', r.v && r.v.torn === true, r.v && r.v.why);
  ok('with the breeds it resembles, which IS the honest answer',
     r.v && r.v.among && r.v.among.length >= 3, r.v && r.v.among);

  console.log('\nSOMETHING IT REALLY DOES KNOW');
  r = await run('dog', [['Golden Retriever', 0.88, 0.71]]);
  ok('one emphatic, unambiguous look is enough', r.v && r.v.ready === true, r.v);
  ok('CONTROL: emphatic but ambiguous is NOT', 
     (await run('dog', [['Golden Retriever', 0.88, 0.05]])).v.ready === false);

  console.log('\nA GUESS THAT CANNOT REPEAT ITSELF');
  /* The tree outside the window: rapeseed, pot, valley. */
  r = await run('', [
    ['Rapeseed', 0.44, 0.18], ['Pot', 0.41, 0.16],
    ['Valley',   0.47, 0.2 ], ['Cotton candy', 0.4, 0.15]
  ]);
  ok('four different answers in four looks claims nothing', r.v && r.v.ready === false, r.v);

  console.log('\nNOT LABELLING THE OBVIOUS');
  const adds = await page.evaluate(()=>({
    same:    EVIDENCE.adds('backpack', 'backpack'),
    plural:  EVIDENCE.adds('dogs', 'dog'),
    caseOnly:EVIDENCE.adds('Backpack', 'backpack'),
    better:  EVIDENCE.adds('Golden Retriever', 'dog'),
    model:   EVIDENCE.adds('Bambu Lab X1 Carbon', 'appliance'),
    empty:   EVIDENCE.adds('', 'dog')
  }));
  ok('the word already on the box adds nothing', adds.same === false && adds.caseOnly === false, adds);
  ok('nor does a plural of it', adds.plural === false, adds.plural);
  ok('CONTROL: a breed does add something', adds.better === true, adds.better);
  ok('CONTROL: so does a make and model', adds.model === true, adds.model);
  ok('and an empty label is never worth saying', adds.empty === false, adds.empty);

  console.log('\nA SPECIALIST OUTRANKS A GENERALIST');
  const rank = await page.evaluate(()=>{
    const t = { cls:'potted plant', label:'Daisy', tier:'local' };
    return {
      speciesOverLocal: EVIDENCE.accept(t, 'species', 'Bellis perennis'),
      cloudOverSpecies: EVIDENCE.accept({cls:'car', label:'Bellis perennis', tier:'species'}, 'cloud', 'Volkswagen Golf'),
      localOverSpecies: EVIDENCE.accept({cls:'potted plant', label:'Bellis perennis', tier:'species'}, 'local', 'Daisy'),
      guessOverLocal:   EVIDENCE.accept({cls:'grid', label:'Doormat', tier:'local'}, 'guess', 'Lemon'),
      obviousFromCloud: EVIDENCE.accept({cls:'backpack', label:'', tier:''}, 'cloud', 'Backpack')
    };
  });
  ok('a species answer replaces a general one', rank.speciesOverLocal === true, rank);
  ok('and the detail tier replaces a species one', rank.cloudOverSpecies === true, rank);
  ok('but a general answer never replaces a species one', rank.localOverSpecies === false, rank);
  ok('and a scene guess never replaces anything', rank.guessOverLocal === false, rank);
  ok('even the detail tier cannot state the obvious', rank.obviousFromCloud === false, rank);

  console.log('\nEVIDENCE GOES STALE');
  const stale = await page.evaluate(()=>{
    const t = { cls:'dog' };
    EVIDENCE.record(t, 'Cocker Spaniel', 0.6, 0.3, 1000);
    EVIDENCE.record(t, 'Cocker Spaniel', 0.6, 0.3, 1300);
    const fresh = EVIDENCE.verdict(t, 1600);
    /* Twenty seconds later the camera is somewhere else entirely. */
    EVIDENCE.record(t, 'Beagle', 0.5, 0.2, 21000);
    return { fresh: fresh.ready, after: Object.keys(t.ev), verdict: EVIDENCE.verdict(t, 21000) };
  });
  ok('SETUP: it was ready while the looks were fresh', stale.fresh === true, stale.fresh);
  ok('old looks stop counting once the camera has moved on',
     stale.after.length === 1 && stale.after[0] === 'Beagle', stale.after);
  ok('so the stale winner is not still being claimed', stale.verdict.ready === false, stale.verdict);

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
