/* Walking directions drawn on the pavement in front of you.

   "navigation must show 3d arrows in front of you ... overlayed with camera
   feed" - the thing Google Maps calls Live View. There is no depth sensing
   behind it and there does not need to be: the ground is flat, the phone is
   held at chest height, and the bearing to the destination is known.

   What is actually checked is where the arrows END UP, by reading the
   pixels of the overlay: straight ahead puts them up the middle, a
   destination to the left puts them left, and no destination puts nothing
   on screen at all. A build that drew arrows all the time, or never, fails
   one of those three.                                                     */
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
  await new Promise(r=>server.listen(8746,r));
  const {chromium}=require('playwright');
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:412,height:892},serviceWorkers:'block'});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message.slice(0,140)));
  await page.goto('http://127.0.0.1:8746/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.UI&&window.MAP&&window.GEO,null,{timeout:20000});

  /* Reads the overlay itself: where is the ink, and how much of it. */
  const shot = (destBearing, heading) => page.evaluate(([db,hd])=>{
    const HERE = {lat:51.5074, lon:-0.1278, acc:8};
    GEO._set(HERE, hd, []);
    if (db === null) { MAP.setDest(null); }
    else {
      /* 200 m away on the given bearing. */
      const R=6371000, p=Math.PI/180, d=200/R, br=db*p;
      const la1=HERE.lat*p, lo1=HERE.lon*p;
      const la2=Math.asin(Math.sin(la1)*Math.cos(d)+Math.cos(la1)*Math.sin(d)*Math.cos(br));
      const lo2=lo1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(la1), Math.cos(d)-Math.sin(la1)*Math.sin(la2));
      MAP.setDest({title:'Test Destination', lat:la2/p, lon:lo2/p,
                   dist:200, bearing:db});
    }
    CAM.toScreen = b2=>b2;
    UI.resize();
    UI.draw([]);
    const cv=document.getElementById('overlay');
    const g=cv.getContext('2d');
    const W=cv.width, H=cv.height;
    const d2=g.getImageData(0,0,W,H).data;
    let n=0, sx=0, top=H, bottom=0;
    /* Only the arrow band: above the readout pill at the very bottom. */
    for(let y=Math.floor(H*0.45); y<Math.floor(H*0.92); y+=2){
      for(let x=0;x<W;x+=2){
        const i=(y*W+x)*4;
        if(d2[i+3]>40 && d2[i+2]>120 && d2[i+2]>d2[i]+40){   // cyan ink
          n++; sx+=x; if(y<top)top=y; if(y>bottom)bottom=y;
        }
      }
    }
    return { n, cx: n? (sx/n)/W : null, top: n? top/H : null, bottom: n? bottom/H : null };
  },[destBearing, heading]);

  console.log('\nNO DESTINATION');
  let r = await shot(null, 0);
  ok('nothing is drawn on the pavement', r.n === 0, r.n);

  console.log('\nSTRAIGHT AHEAD');
  r = await shot(0, 0);
  ok('arrows appear', r.n > 200, r.n);
  ok('and they run up the middle', r.cx > 0.42 && r.cx < 0.58, r.cx && +r.cx.toFixed(3));
  ok('they lie in front of you, not up in the sky', r.top > 0.45 && r.bottom > 0.75,
     {top:+r.top.toFixed(2), bottom:+r.bottom.toFixed(2)});

  console.log('\nTHE DESTINATION IS TO THE LEFT');
  const straight = r.cx;
  r = await shot(300, 0);           // 60 degrees to the left
  ok('arrows are still drawn', r.n > 200, r.n);
  ok('and they lean left', r.cx < straight - 0.05, {left:+r.cx.toFixed(3), ahead:+straight.toFixed(3)});

  console.log('\nAND TO THE RIGHT');
  r = await shot(60, 0);
  ok('they lean right', r.cx > straight + 0.05, {right:+r.cx.toFixed(3), ahead:+straight.toFixed(3)});

  console.log('\nTURNING THE PHONE MOVES THEM');
  /* Same destination, but now facing it: they should come back to centre. */
  r = await shot(60, 60);
  ok('facing the destination brings them back to the middle', r.cx > 0.42 && r.cx < 0.58, r.cx && +r.cx.toFixed(3));

  console.log('\nTHE DESTINATION IS BEHIND YOU');
  r = await shot(180, 0);
  ok('it still says something rather than drawing off-screen', r.n > 50, r.n);

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close();server.close();process.exit(fail?1:0);
})();
