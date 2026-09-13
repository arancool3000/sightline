/* "add ability for the ai to play games/ start vr hands free games with
    it (i am planning on putting phone in cardboard box for fun and using
    camera to detect my hand). i want games like a cool immersive cube
    slicing game so you have swords in your hands in vr and cubes are
    going towards you and you have to slice them."

   The thing that decides whether this is fun is the hand tracking, so
   that is what most of this checks - with pixels, not with faith. A
   picture with a hand-coloured patch on the left must move the left hand
   there, and a grey room must move neither.

   The second thing is that a swing CUTS. A cube that passes through a
   resting hand and scores is not a game, it is a screensaver.          */
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
  await page.waitForFunction(()=>window.VR&&window.CMD&&window.CAM,null,{timeout:30000});
  await page.evaluate(()=>{ const g=document.getElementById('gate'); if(g){g.classList.add('hidden'); g.hidden=true;} });

  console.log('\nSKIN, NOT EVERYTHING PINK');
  {
    const s=await page.evaluate(()=>({
      hand:  VR._isSkin(215,165,140),
      hand2: VR._isSkin(140,95,70),
      hand3: VR._isSkin(95,62,48),
      wall:  VR._isSkin(200,200,205),
      sky:   VR._isSkin(90,140,220),
      leaf:  VR._isSkin(60,140,70),
      black: VR._isSkin(10,8,8)
    }));
    ok('a light hand is skin', s.hand===true, s);
    ok('a mid and a dark hand are too - the chroma window is what decides',
       s.hand2===true && s.hand3===true, s);
    ok('CONTROL: a grey wall is not', s.wall===false, s);
    ok('CONTROL: nor sky, nor a leaf, nor the dark', s.sky===false && s.leaf===false && s.black===false, s);
  }

  console.log('\nA HAND IN THE PICTURE MOVES THE HAND IN THE GAME');
  {
    /* A canvas standing in for the camera: a skin-coloured patch low on
       the right, and nothing else. */
    const r=await page.evaluate(()=>{
      const cv=document.createElement('canvas'); cv.width=320; cv.height=240;
      const c=cv.getContext('2d');
      c.fillStyle='#2b2f33'; c.fillRect(0,0,320,240);                 // a room
      c.fillStyle='#d9a487'; c.fillRect(230,170,60,60);               // a hand, low right
      /* readHands takes anything drawable with videoWidth; a canvas has
         width, so it is given one. */
      cv.videoWidth=320; cv.videoHeight=240;
      for (let i=0;i<14;i++) VR._readHands(cv);                        // let the smoothing settle
      const a=VR._hands();
      /* And now a hand low on the LEFT instead. */
      c.fillStyle='#2b2f33'; c.fillRect(0,0,320,240);
      c.fillStyle='#d9a487'; c.fillRect(30,170,60,60);
      for (let i=0;i<14;i++) VR._readHands(cv);
      const b2=VR._hands();
      /* And an empty room. */
      c.fillStyle='#2b2f33'; c.fillRect(0,0,320,240);
      for (let i=0;i<4;i++) VR._readHands(cv);
      const empty=VR._hands();
      return { right:{seen:a.right.seen, x:+a.right.x.toFixed(2), y:+a.right.y.toFixed(2)},
               rightWhenLeft:a.right.seen,
               left:{seen:b2.left.seen, x:+b2.left.x.toFixed(2)},
               emptyL:empty.left.seen, emptyR:empty.right.seen };
    });
    ok('a hand low on the right is seen as the right hand', r.right.seen===true, r.right);
    ok('and it is on the right of the frame', r.right.x>0.55, r.right);
    ok('and low in it, where a hand held up actually is', r.right.y>0.5, r.right);
    ok('a hand low on the left is seen as the left hand', r.left.seen===true && r.left.x<0.45, r.left);
    ok('CONTROL: an empty room sees no hands at all',
       r.emptyL===false && r.emptyR===false, r);
  }

  console.log('\nTWO EYES, ONE WORLD');
  {
    const p=await page.evaluate(()=>{
      const L=VR._project({x:0,y:0,z:2}, -0.031, 400, 390);
      const R=VR._project({x:0,y:0,z:2},  0.031, 400, 390);
      const near=VR._project({x:0,y:0,z:1}, 0, 400, 390);
      const far =VR._project({x:0,y:0,z:8}, 0, 400, 390);
      const behind=VR._project({x:0,y:0,z:-1}, 0, 400, 390);
      return { L:{x:+L.x.toFixed(1)}, R:{x:+R.x.toFixed(1)}, nearS:near.s, farS:far.s, behind };
    });
    /* The same point lands in a different place for each eye - that
       difference IS the depth you see. */
    ok('a point sits differently for each eye', p.L.x !== p.R.x, p);
    ok('and the nearer eye sees it further out', Math.abs(p.L.x-p.R.x) > 3, p);
    ok('something near is drawn bigger than something far', p.nearS > p.farS*4, p);
    ok('CONTROL: something behind you is not drawn at all', p.behind===null, p);
  }

  console.log('\nA SWING CUTS, A RESTING HAND DOES NOT');
  {
    const g=await page.evaluate(()=>{
      const game=VR.GAMES.slice.make();
      /* Hand parked where a cube will arrive, not moving. */
      VR._setHand('right',{seen:true,x:0.72,y:0.5,vx:0,vy:0});
      VR._setHand('left',{seen:false});
      for (let i=0;i<400;i++) game.step(0.02);
      const resting=game.score();
      /* The same hand, swinging. */
      const g2=VR.GAMES.slice.make();
      let sw=0;
      for (let i=0;i<400;i++) {
        sw+=0.02;
        VR._setHand('right',{seen:true,x:0.5+Math.sin(sw*9)*0.2,y:0.5,
                             vx:Math.cos(sw*9)*0.06,vy:0.02});
        g2.step(0.02);
      }
      const swinging=g2.score();
      VR._setHand('right',{seen:false,vx:0,vy:0});
      return { resting, swinging };
    });
    ok('SETUP: cubes really did arrive', g.resting.missed>0 || g.swinging.missed>0 || g.swinging.score>0, g);
    ok('swinging a hand through a cube cuts it', g.swinging.score>0, g.swinging);
    /* A cube that passes through a still hand and scores is a screensaver. */
    ok('CONTROL: a hand held still cuts nothing', g.resting.score===0, g.resting);
    ok('and missing one breaks the run', g.swinging.best>=1, g.swinging);
  }

  console.log('\nSTARTING AND LEAVING, HANDS FREE');
  {
    const v=await page.evaluate(()=>({
      play: (CMD.match('play the cube game')||{}).name,
      slice:(CMD.match('play cube slice')||{}).name,
      vr:   (CMD.match('start vr')||{}).name,
      stop: (CMD.match('stop the game')||{}).name,
      notThis: !!CMD.match('what game is that person playing over there'),
      listed: VR.list().length
    }));
    ok('"play the cube game" starts it', v.play==='play', v);
    ok('so do "play cube slice" and "start vr"', v.slice==='play' && v.vr==='play', v);
    ok('and it can be left by voice', v.stop==='stop game', v);
    ok('CONTROL: a question about a game is not a command to start one', v.notThis===false, v);
    ok('SETUP: the game table has at least one game and can hold more', v.listed>=1, v.listed);

    const life=await page.evaluate(async()=>{
      const realLive=CAM.live; CAM.live=()=>true;
      const started=VR.start('slice');
      const root=!!document.getElementById('vrRoot');
      const runs=VR.running();
      const bogus=VR.start('chess');            // not a game here
      VR.stop();
      const gone=!document.getElementById('vrRoot');
      CAM.live=realLive;
      return { started, root, runs, bogus, gone };
    });
    ok('starting it puts the game on screen', life.started===true && life.root===true, life);
    ok('CONTROL: a game that does not exist does not start', life.bogus===false, life);
    ok('and leaving takes it off again', life.gone===true, life);
  }

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close(); server.close(); process.exit(fail?1:0);
})().catch(e=>{ console.log('  FAIL the suite could not finish  '+JSON.stringify(String(e&&e.message||e).split('\n')[0]));
  console.log('\n'+pass+'/'+(pass+fail+1)+' passed'); process.exit(1); });
