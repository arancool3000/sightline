/* Following the road, not the bearing.

   "MAKE IT SHOW THE ARROWS POINTING TO THE END OF THE ROAD YOU ARE SUPPOSED
    TO GO DOWN OR IF THE ROAD IS CURVED MAKE THE CURVE ... SO YOU CAN FOLLOW
    IT AND ONCE YOU GET THERE IT SHOULD RECALIBRATE TO THE END OF THE NEXT
    ROAD ON THE PATH TO YOUR DESTINATION."

   A street grid is seeded directly, so what is under test is the routing
   and the recalibration rather than whether Overpass answered today.

   The controls carry the weight here. "It found a path" is also true of a
   build that walks through walls, so the route is checked for STAYING on
   the roads; and "the arrows curve" is true of a build that scatters them,
   so the curve is checked for matching the road's own shape.             */
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
  await new Promise(r=>server.listen(8748,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  await page.goto('http://127.0.0.1:8748/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.ROUTE&&window.ROADS&&window.GEO,null,{timeout:20000});

  /* Two straight streets meeting at a corner, plus a curved one. All are
     built from a shared junction coordinate, which is what joins them. */
  const seed = await page.evaluate(()=>{
    const LAT=51.5000, LON=-0.1000;
    const dLat = 1/111320, dLon = 1/(111320*Math.cos(LAT*Math.PI/180));

    // High Street: 300 m due east from the origin.
    const high=[]; for(let m=0;m<=300;m+=20) high.push([LAT, LON+m*dLon]);
    // Mill Lane: 260 m due north from the END of High Street.
    const mill=[]; for(let m=0;m<=260;m+=20) mill.push([LAT+m*dLat, LON+300*dLon]);
    // Church Bend: a quarter circle of radius 120 m off the end of Mill Lane.
    const bend=[];
    for(let a=0;a<=90;a+=7.5){
      const r=120, t=a*Math.PI/180;
      bend.push([LAT+(260+r*Math.sin(t))*dLat, LON+(300-r*(1-Math.cos(t)))*dLon]);
    }
    ROADS._tiles()['t']={at:Date.now(), bld:[], ways:[
      {k:'residential', n:'High Street', pts:high},
      {k:'residential', n:'Mill Lane',   pts:mill},
      {k:'residential', n:'Church Bend', pts:bend}
    ]};
    ROUTE._build();
    return {
      start:[LAT, LON],
      cornerA:[LAT, LON+300*dLon],
      end: bend[bend.length-1],
      nodes: Object.keys(ROUTE._graph().nodes).length
    };
  });
  ok('SETUP: a street network was built', seed.nodes > 40, seed.nodes);

  console.log('\nPLANNING A ROUTE');
  let r = await page.evaluate((s)=>{
    const p = ROUTE.plan(s.start, s.end);
    return p && { legs: p.legs.map(l=>({name:l.name, m:Math.round(l.metres), pts:l.pts.length})),
                  metres: p.metres };
  }, seed);
  ok('a route is found', !!r, r);
  ok('and it runs along the three named roads',
     !!r && r.legs.map(l=>l.name).join(' > ') === 'High Street > Mill Lane > Church Bend',
     r && r.legs.map(l=>l.name));
  ok('its length is about the 750 m of road it covers',
     !!r && r.metres > 620 && r.metres < 900, r && r.metres);
  ok('CONTROL: it did not cut the corner - a straight line would be far shorter',
     !!r && r.metres > 500, r && r.metres);

  console.log('\nWHAT AM I FOLLOWING RIGHT NOW');
  let f = await page.evaluate((s)=>{
    const g = ROUTE.follow(s.start);
    return g && { road:g.leg.name, left:g.legLeft, off:g.offRoute,
                  remaining:g.remaining, ahead:g.ahead.length, arrived:g.arrived };
  }, seed);
  ok('at the start it is following High Street', f && f.road === 'High Street', f);
  ok('with the whole of it still ahead', f && f.left > 250 && f.left < 340, f && f.left);
  ok('and it knows I am on the road, not beside it', f && f.off < 5, f && f.off);

  console.log('\nRECALIBRATING AT THE END OF THE ROAD');
  f = await page.evaluate((s)=>{
    const g = ROUTE.follow(s.cornerA);      // standing at the High Street / Mill Lane corner
    return g && { road:g.leg.name, left:g.legLeft, next:g.next&&g.next.name, turn:g.turn };
  }, seed);
  ok('at the corner it has moved on to Mill Lane', f && f.road === 'Mill Lane', f);
  ok('CONTROL: and High Street is behind us, not still being followed', f && f.road !== 'High Street', f);

  /* Just before the corner: still High Street, but the turn is announced. */
  f = await page.evaluate((s)=>{
    const LAT=51.5, dLon=1/(111320*Math.cos(LAT*Math.PI/180));
    const g = ROUTE.follow([LAT, -0.1+292*dLon]);
    return g && { road:g.leg.name, left:g.legLeft, next:g.next&&g.next.name, turn:g.turn };
  }, seed);
  ok('approaching the corner it names the next road', f && f.next === 'Mill Lane', f);
  ok('and which way to turn', f && f.turn === 'left', f && f.turn);

  console.log('\nTHE CURVE IS FOLLOWED, NOT CUT');
  const bendInfo = await page.evaluate((s)=>{
    // Stand at the start of Church Bend and look at the line ahead.
    const LAT=51.5, dLat=1/111320, dLon=1/(111320*Math.cos(LAT*Math.PI/180));
    const atBend=[LAT+260*dLat, -0.1+300*dLon];
    const g = ROUTE.follow(atBend);
    if(!g) return null;
    // Bearing from each point to the next, along the road ahead.
    const bs=[];
    for(let i=1;i<g.ahead.length;i++) bs.push(ROUTE.bearing(g.ahead[i-1], g.ahead[i]));
    const spread = Math.max(...bs) - Math.min(...bs);
    // Straight-line bearing from the start of the bend to its end.
    const direct = ROUTE.bearing(g.ahead[0], g.ahead[g.ahead.length-1]);
    return { road:g.leg.name, n:bs.length, spread, first:bs[0], last:bs[bs.length-1], direct };
  }, seed);
  ok('the bend is the road being followed', bendInfo && bendInfo.road === 'Church Bend', bendInfo && bendInfo.road);
  ok('the line ahead turns through about a quarter circle',
     bendInfo && bendInfo.spread > 60 && bendInfo.spread < 110, bendInfo && Math.round(bendInfo.spread));
  ok('CONTROL: so it is NOT a straight line to the end',
     bendInfo && Math.abs(bendInfo.first - bendInfo.direct) > 20,
     bendInfo && {first:Math.round(bendInfo.first), direct:Math.round(bendInfo.direct)});

  console.log('\nARRIVING');
  f = await page.evaluate((s)=>{
    const g = ROUTE.follow(s.end);
    return g && { arrived:g.arrived, remaining:g.remaining };
  }, seed);
  ok('standing at the destination it says so', f && f.arrived === true, f);

  console.log('\nWHEN THERE IS NO ROAD DATA');
  const none = await page.evaluate(()=>{
    ROADS._tiles()['t'] = {at:Date.now(), bld:[], ways:[]};
    ROUTE._build();
    ROUTE.clear();
    return { planned: ROUTE.plan([51.5,-0.1],[51.51,-0.1]), follow: ROUTE.follow([51.5,-0.1]) };
  });
  ok('it plans nothing rather than inventing a road', none.planned === null, none.planned);
  ok('and following nothing answers nothing', none.follow === null, none.follow);

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
