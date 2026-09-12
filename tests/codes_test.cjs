/* What a scanned code turns into.

   A barcode is a number and a QR is a string; neither is an answer. This
   checks the two paths that make them one - a food product looked up in
   Open Food Facts, and a link shown for what it is before it is opened.

   Open Food Facts is stubbed, deliberately: the point is what the app does
   with an answer, and a test that depends on one particular jar of sauce
   still being in an open database goes red for reasons that have nothing
   to do with this code.                                                   */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=http.createServer((q,res)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('  ok   '+n);}else{fail++;console.log('  FAIL '+n+(x===undefined?'':'  '+JSON.stringify(x)));}};

/* A sugary ultra-processed drink and a plain bag of oats, in the shape Open
   Food Facts really answers in. */
const SODA = { status:1, product:{
  product_name:'Fizzy Orange', brands:'Acme', quantity:'330 ml',
  nutriscore_grade:'e', nutriscore_data:{score:18}, nova_group:4,
  additives_tags:['en:e330','en:e211','en:e150d','en:e952'],
  allergens_tags:[], nutrient_levels:{fat:'low',sugars:'high',salt:'low'},
  ingredients_text:'Water, sugar, acid (citric acid), preservative (sodium benzoate)' }};
const OATS = { status:1, product:{
  product_name:'Rolled Oats', brands:'Millhouse', quantity:'1 kg',
  nutriscore_grade:'a', nutriscore_data:{score:-4}, nova_group:1,
  additives_tags:[], allergens_tags:['en:gluten'],
  nutrient_levels:{fat:'moderate',sugars:'low',salt:'low'},
  ingredients_text:'Wholegrain oats' }};

(async()=>{
  await new Promise(r=>server.listen(8747,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));

  await page.route('**/world.openfoodfacts.org/**', route=>{
    const url = route.request().url();
    const body = /5000001/.test(url) ? SODA : /5000002/.test(url) ? OATS : {status:0};
    route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(body)});
  });

  await page.goto('http://127.0.0.1:8747/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.CODES&&window.UI,null,{timeout:20000});

  const scan = (value, format) => page.evaluate(async ([v,f])=>{
    const got = CODES.resolve({value:v, format:f, box:[0,0,10,10], at:Date.now()});
    await got.done;
    return got.record;
  },[value,format]);

  console.log('\nA SUGARY DRINK');
  let r = await scan('5000001234567','ean 13');
  ok('it is recognised as a product', r.kind === 'product', r.kind);
  ok('with its name and brand', r.name === 'Fizzy Orange' && r.brand === 'Acme', [r.name,r.brand]);
  ok('it gets a health score', !!r.health, r.health);
  ok('and the score is a poor one', r.health && r.health.score < 35, r.health && r.health.score);
  ok('the additives are listed', r.additives.length === 4, r.additives.map(a=>a.code));
  ok('and the ones we know are explained',
     r.additives.some(a=>/benzoate/i.test(a.what)) && r.additives.some(a=>/citric/i.test(a.what)),
     r.additives);
  ok('the working is shown, not just the number',
     r.health.parts.length >= 3 && r.health.parts.some(p=>/ultra-processed/i.test(p.k)),
     r.health.parts.map(p=>p.k));
  ok('sugar is flagged as high', r.levels.some(l=>l.k==='Sugar'&&l.v==='high'), r.levels);

  console.log('\nA BAG OF OATS');
  const soda = r;
  r = await scan('5000002234567','ean 13');
  ok('CONTROL: a wholefood scores far better', r.health.score > soda.health.score + 40,
     {oats:r.health.score, soda:soda.health.score});
  ok('CONTROL: and has no additives to list', r.additives.length === 0, r.additives);
  ok('its allergen is carried through', r.allergens.join()==='gluten', r.allergens);

  console.log('\nSOMETHING NOT IN THE DATABASE');
  r = await scan('9999999999999','ean 13');
  ok('it says so rather than inventing a score', r.missing === true && !r.health, r);

  console.log('\nA QR CODE WITH A LINK');
  r = await scan('https://example.com/menu','qr code');
  ok('it is recognised as a link', r.kind === 'link', r.kind);
  ok('the site is named plainly', r.name === 'example.com', r.name);
  ok('an ordinary https link raises nothing', r.risks.length === 0, r.risks);

  console.log('\nTHE TRICKS A QR CODE ON A WALL PLAYS');
  const risky = await page.evaluate(()=>({
    plain:    CODES.risks(new URL('http://example.com/pay')),
    deep:     CODES.risks(new URL('https://paypal.com.login.secure.xyz/account')),
    ip:       CODES.risks(new URL('https://192.168.4.21/admin')),
    shortened:CODES.risks(new URL('https://bit.ly/3xYzAb')),
    punycode: CODES.risks(new URL('https://xn--80ak6aa92e.com/')),
    safe:     CODES.risks(new URL('https://www.bbc.co.uk/news')),
    safe2:    CODES.risks(new URL('https://shop.john-lewis.com/x')),
    safe3:    CODES.risks(new URL('https://docs.google.com/a')),
    midTld:   CODES.risks(new URL('https://yourbank.com.verify.example.org/login'))
  }));
  ok('an unencrypted link is called out', /not encrypted/i.test(risky.plain.join()), risky.plain);
  ok('a deep lookalike address is called out', risky.deep.length > 0, risky.deep);
  ok('a bare IP address is called out', risky.ip.length > 0, risky.ip);
  ok('a shortened link is called out', /shortened/i.test(risky.shortened.join()), risky.shortened);
  ok('a lookalike character set is called out', /look like/i.test(risky.punycode.join()), risky.punycode);
  ok('CONTROL: a www.something.co.uk is NOT called out', risky.safe.length === 0, risky.safe);
  ok('CONTROL: nor an ordinary subdomain', risky.safe2.length === 0 && risky.safe3.length === 0,
     [risky.safe2, risky.safe3]);
  ok('a top-level domain used as a middle label IS called out',
     /middle/i.test(risky.midTld.join()), risky.midTld);

  console.log('\nTHE CARD ON SCREEN');
  const card = await page.evaluate(async ()=>{
    const hit = {value:'5000001234567', format:'ean 13', box:[0,0,10,10], at:Date.now()};
    const got = CODES.resolve(hit);
    await got.done;
    UI.init && null;
    const before = document.getElementById('codeCard').hidden;
    /* Drive it the way the scanner does. */
    SCAN.on(()=>{});
    window.dispatchEvent(new Event('resize'));
    UI.showCodeForTest ? UI.showCodeForTest(hit) : null;
    return { before };
  });
  ok('SETUP: the card starts hidden', card.before === true, card.before);

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
