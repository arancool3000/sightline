/* Speed, distance and moving time, from the device's own GPS.

   The failure this guards against is the obvious one: a phone lying on a
   table walks a marathon overnight, because a GPS fix jitters by several
   metres and every jitter looks like a step. So a fix is only counted when
   it moves further than the accuracy it was reported with.

   The controls are what make that meaningful - a build that simply counted
   nothing would also pass "a stationary phone travels no distance".       */
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
  await new Promise(r=>server.listen(8743,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block',permissions:['geolocation']});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,120)));

  /* watchPosition is replaced before anything loads so fixes can be fed in
     one at a time, which is the only way to test the jitter rule. */
  await page.addInitScript(()=>{
    window.__fixes = [];
    navigator.geolocation.watchPosition = function (okCb) { window.__send = okCb; return 7; };
    navigator.geolocation.clearWatch = function () {};
  });
  await page.goto('http://127.0.0.1:8743/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.GEO&&window.MAP,null,{timeout:20000});

  const feed = (pts) => page.evaluate((pts)=>{
    GEO.resetTrip();
    GEO.start();
    pts.forEach(p=>window.__send({
      coords:{latitude:p[0],longitude:p[1],accuracy:p[2],speed:(p[3]===undefined?null:p[3])},
      timestamp:p[4]
    }));
    const s = GEO.state();
    return { metres: s.trip.metres, moving: s.trip.movingMs, speed: s.trip.speed,
             dist: GEO.distText(), pace: GEO.paceText(), spd: GEO.speedText() };
  }, pts);

  console.log('\nA PHONE ON A TABLE');
  // Twenty fixes wandering inside a 10 m accuracy circle, over ten minutes.
  const jitter=[]; let t0=1700000000000;
  for(let i=0;i<20;i++){
    jitter.push([51.5074 + (Math.sin(i*2.3)*0.00005), -0.1278 + (Math.cos(i*1.7)*0.00005), 10, 0, t0 + i*30000]);
  }
  let r = await feed(jitter);
  ok('a stationary phone records no distance', r.metres === 0, r);
  ok('and no moving time', r.moving === 0, r.moving);
  ok('and reads zero speed', /^0\.0/.test(r.spd), r.spd);
  ok('and offers no pace, rather than a nonsense one', r.pace === '', r.pace);

  console.log('\nSOMEONE WALKING');
  // Due north, 15 m every 10 s - 1.5 m/s, an ordinary walking pace.
  const walk=[]; t0=1700000000000;
  for(let i=0;i<21;i++) walk.push([51.5074 + i*0.000135, -0.1278, 6, 1.5, t0 + i*10000]);
  r = await feed(walk);
  ok('SETUP: 20 steps of 15 m is about 300 m', r.metres > 250 && r.metres < 350, Math.round(r.metres));
  ok('the distance is reported in metres while it is short', /m$/.test(r.dist) && !/km/.test(r.dist), r.dist);
  ok('moving time is about the 200 seconds it took', r.moving > 150000 && r.moving < 230000, Math.round(r.moving/1000)+'s');
  ok('the speed is a walking speed', /^5\.[0-9] km\/h/.test(r.spd), r.spd);
  ok('and the pace is about eleven minutes a kilometre', /^11:/.test(r.pace), r.pace);

  console.log('\nA BAD FIX IS NOT A CAR');
  const jump = [
    [51.5074, -0.1278, 6, 1.4, t0],
    [51.5075, -0.1278, 6, 1.4, t0+10000],
    [51.9000, -0.1278, 900, null, t0+20000],     // a 43 km leap, huge accuracy
    [51.5076, -0.1278, 6, 1.4, t0+30000]
  ];
  r = await feed(jump);
  ok('a wild fix does not add tens of kilometres', r.metres < 1000, Math.round(r.metres));
  ok('CONTROL: the good fixes around it were still counted', r.metres > 5, Math.round(r.metres));

  console.log('\nLONGER DISTANCES READ IN KILOMETRES');
  const far=[]; t0=1700000000000;
  for(let i=0;i<60;i++) far.push([51.5074 + i*0.0005, -0.1278, 6, 5, t0 + i*10000]);
  r = await feed(far);
  ok('past a kilometre it switches units', /km$/.test(r.dist), r.dist);

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
