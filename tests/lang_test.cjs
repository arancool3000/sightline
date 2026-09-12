/* "captions should translate from detected language to english"

   Web Speech cannot detect a language - it listens for one and returns its
   best attempt in that language - so "auto" used to mean the device's
   language, and the translator was told the wrong source every time a
   visitor spoke.

   The language is read off the words that actually came back instead. This
   drives the real detectLang over sentences in twelve languages, and the
   controls matter: a detector that answered "es" for everything would pass
   a Spanish-only test, and one that answered "" for everything would pass
   any test that only checks it does not lie.                             */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=http.createServer((q,res)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('  ok   '+n);}else{fail++;console.log('  FAIL '+n+(x===undefined?'':'  '+JSON.stringify(x)));}};

const CASES = [
  ['en', 'the dinner is at seven and you have to be there with the others'],
  ['es', 'la cena es a las siete y tienes que estar con los demas'],
  ['fr', 'le diner est a sept heures et vous devez etre la avec les autres'],
  ['de', 'das essen ist um sieben und du musst mit den anderen dort sein'],
  ['it', 'la cena e alle sette e devi essere li con gli altri'],
  ['pt', 'o jantar e as sete e voce tem que estar la com os outros'],
  ['nl', 'het eten is om zeven uur en je moet er met de anderen zijn'],
  ['pl', 'kolacja jest o siodmej i nie mozna sie spoznic na to'],
  ['ru', 'ужин в семь часов и вы должны быть там с другими'],
  ['ar', 'العشاء في الساعة السابعة ويجب أن تكون هناك'],
  ['el', 'το δειπνο ειναι στις επτα και πρεπει να εισαι εκει'],
  ['ja', 'ディナーは七時です。みんなと一緒に来てください'],
  ['ko', '저녁은 일곱시입니다 다른 사람들과 함께 오세요'],
  ['th', 'อาหารเย็นเวลาเจ็ดโมงและคุณต้องอยู่ที่นั่น'],
  ['hi', 'रात का खाना सात बजे है और आपको वहाँ होना चाहिए']
];

(async()=>{
  await new Promise(r=>server.listen(8739,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  await page.goto('http://127.0.0.1:8739/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.CAPS&&CAPS.detectLang,null,{timeout:20000});

  console.log('\nWHAT LANGUAGE IS THIS');
  const got = await page.evaluate((cases)=>cases.map(c=>[c[0],CAPS.detectLang(c[1])]), CASES);
  let right=0;
  got.forEach(([want,have])=>{
    ok(want+' is recognised as '+want, have===want, {want,have});
    if(have===want) right++;
  });
  ok('SETUP: it does not answer the same thing for everything',
     new Set(got.map(g=>g[1])).size>=8, got.map(g=>g[1]));
  ok('SETUP: and it is not simply returning nothing',
     got.filter(g=>g[1]).length>=13, got.filter(g=>!g[1]).map(g=>g[0]));

  console.log('\nWHEN IT SHOULD SAY NOTHING');
  const quiet = await page.evaluate(()=>[
    CAPS.detectLang(''), CAPS.detectLang('   '), CAPS.detectLang('hmm'),
    CAPS.detectLang('xyzzy plugh frotz blorple'), CAPS.detectLang('7 42 19')
  ]);
  ok('empty, a single grunt and nonsense all decline to answer',
     quiet.every(v=>v===''), quiet);

  console.log('\n'+pass+'/'+(pass+fail)+' passed  ('+right+'/'+CASES.length+' languages)');
  await b.close();server.close();process.exit(fail?1:0);
})();
