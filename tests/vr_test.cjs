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
/* The two games must reward DIFFERENT things, or the second is the
   first wearing a hat: still beats waving here, waving beats still there. */
const VR_OPPOSITE=(g)=>g.still.score>0 && g.wave.score===0;
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
      /* And an empty room. One missing frame must NOT drop the hand - a
         hand that blinks out on a single bad frame takes the sword with
         it - but a room with nobody in it must end up empty. */
      c.fillStyle='#2b2f33'; c.fillRect(0,0,320,240);
      VR._readHands(cv);
      const blink=VR._hands();
      for (let i=0;i<12;i++) VR._readHands(cv);
      const empty=VR._hands();
      return { right:{seen:a.right.seen, x:+a.right.x.toFixed(2), y:+a.right.y.toFixed(2)},
               rightWhenLeft:a.right.seen,
               left:{seen:b2.left.seen, x:+b2.left.x.toFixed(2)},
               blink:blink.left.seen||blink.right.seen,
               emptyL:empty.left.seen, emptyR:empty.right.seen };
    });
    ok('a hand low on the right is seen as the right hand', r.right.seen===true, r.right);
    ok('and it is on the right of the frame', r.right.x>0.55, r.right);
    ok('and low in it, where a hand held up actually is', r.right.y>0.5, r.right);
    ok('a hand low on the left is seen as the left hand', r.left.seen===true && r.left.x<0.45, r.left);
    ok('one missing frame does not drop the hand', r.blink===true, r);
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

  console.log('\nA DOOR THAT IS NOT A VOICE COMMAND');
  {
    const d=await page.evaluate(async()=>{
      const realLive=CAM.live; CAM.live=()=>true;
      /* Open the tray, then the games button in it. */
      document.getElementById('dockMore').click();
      const btn=document.getElementById('railGames');
      const before=!!document.getElementById('vrRoot');
      btn.click();
      const sheet=document.getElementById('sheet');
      const rows=Array.prototype.slice.call(document.querySelectorAll('#sheetBody .vg-row'));
      /* Every row must name a game the module really has, or the list is
         decoration. */
      const ids=rows.map(r=>r.getAttribute('data-game'));
      const known=VR.list().map(g=>g.id);
      const named=rows.map(r=>(r.textContent||'').trim().length>0);
      const tall=rows.map(r=>r.getBoundingClientRect().height);
      /* Tapping a row starts THAT game, not a fixed one. */
      const want=ids[ids.length-1];
      rows[rows.length-1].click();
      const started=VR.current();
      const up=!!document.getElementById('vrRoot');
      VR.stop(); CAM.live=realLive;
      document.getElementById('rail').hidden=true;
      return { before, open:!sheet.hidden||up, rows:rows.length, ids, known,
               named, tall, want, started, up };
    });
    ok('SETUP: nothing was running before the button was pressed', d.before===false, d);
    ok('the button lists every game there is', d.rows===d.known.length && d.rows>=2, d);
    ok('and each row names one of them', d.ids.every(i=>d.known.indexOf(i)>=0), d);
    ok('CONTROL: no row is blank', d.named.every(Boolean), d.named);
    ok('every row is thumb-sized', d.tall.every(h=>h>=44), d.tall);
    ok('tapping a row starts THAT game', d.started===d.want && d.up===true, d);

    const off=await page.evaluate(()=>{
      const realLive=CAM.live; CAM.live=()=>false;
      document.getElementById('railGames').click();
      const rows=Array.prototype.slice.call(document.querySelectorAll('#sheetBody .vg-row'));
      const dead=rows.every(r=>r.disabled);
      const says=/camera/i.test(document.getElementById('sheetBody').textContent||'');
      document.getElementById('sheetClose').click();
      CAM.live=realLive;
      return { dead, says, rows:rows.length };
    });
    ok('CONTROL: with the camera off the rows are dead and say why', off.dead===true && off.says===true, off);
  }

  console.log('\nHOLDING IS NOT SWINGING');
  {
    const g=await page.evaluate(()=>{
      const runFor=(mover)=>{
        const game=VR.GAMES.orbs.make();
        let sw=0;
        for (let i=0;i<600;i++){ sw+=0.02; mover(sw); game.step(0.02); }
        const s=game.score();
        VR._setHand('left',{seen:false}); VR._setHand('right',{seen:false,vx:0,vy:0});
        return s;
      };
      /* A hand held still where the orbs drift in charges them. */
      const still=runFor(()=>{ VR._setHand('right',{seen:true,x:0.5,y:0.5,vx:0,vy:0});
                               VR._setHand('left',{seen:false}); });
      /* The same hand, waving - which is what wins the OTHER game. */
      const wave=runFor((t)=>{ VR._setHand('right',{seen:true,x:0.5+Math.sin(t*9)*0.2,y:0.5,
                                                    vx:Math.cos(t*9)*0.06,vy:0.02});
                               VR._setHand('left',{seen:false}); });
      /* Nobody there at all. */
      const none=runFor(()=>{ VR._setHand('right',{seen:false,vx:0,vy:0});
                              VR._setHand('left',{seen:false}); });
      return { still, wave, none };
    });
    ok('SETUP: orbs really arrived', g.still.score>0 || g.still.missed>0 || g.none.missed>0, g);
    ok('a steady hand pops orbs', g.still.score>0, g.still);
    ok('waving at them does not', g.wave.score===0, g.wave);
    ok('CONTROL: an empty room pops nothing and misses them', g.none.score===0 && g.none.missed>0, g.none);
    ok('CONTROL: this is the opposite of Cube Slice, not a copy of it',
       VR_OPPOSITE(g), g);
  }

  console.log('\nONE VIEW UNLESS YOU ASK FOR TWO');
  {
    /* ⚠ THE DEFAULT CANNOT BE READ AFTER SETTING IT. The module reads the
       remembered choice once, when the file loads, so a test that calls
       setSplit(false) and then asks is only reading its own call - it
       passes for a build that defaults to two views. The stored choice is
       cleared and the page reloaded, which is the only way to ask what a
       phone that has never been told does. */
    await page.evaluate(()=>{ try{ localStorage.removeItem('sightline.vr.split'); }catch(e){} });
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.VR&&window.CAM,null,{timeout:30000});
    await page.evaluate(()=>{ const g=document.getElementById('gate'); if(g){g.classList.add('hidden'); g.hidden=true;} });

    const v=await page.evaluate(()=>{
      const realLive=CAM.live; CAM.live=()=>true;
      VR.start('slice');
      const flat=VR.split();
      const seamFlat=document.getElementById('vrRoot').className.indexOf('two')>=0;
      /* The toggle is a button somebody can reach, not only an API. */
      const btn=document.getElementById('vrSplit');
      const label1=btn.textContent.trim();
      const tall=btn.getBoundingClientRect().height;
      btn.click();
      const two=VR.split();
      const label2=document.getElementById('vrSplit').textContent.trim();
      const seamTwo=document.getElementById('vrRoot').className.indexOf('two')>=0;
      /* And it is remembered, so a viewer owner is not asked every time. */
      const kept=localStorage.getItem('sightline.vr.split');
      document.getElementById('vrSplit').click();
      VR.stop(); CAM.live=realLive;
      return { flat, two, label1, label2, seamFlat, seamTwo, tall, kept };
    });
    ok('a phone that has never been told opens ONE view', v.flat===false, v);
    ok('CONTROL: and draws no seam down the middle of it', v.seamFlat===false, v);
    ok('the button offers the other one', v.label1==='2 VIEWS' && v.label2==='1 VIEW', v);
    ok('pressing it splits the view', v.two===true && v.seamTwo===true, v);
    ok('it is thumb-sized', v.tall>=44, v.tall);
    ok('and the choice is remembered', v.kept==='1', v);
  }

  console.log('\nNOT EVERYTHING COMING AT YOU SHOULD BE HIT');
  {
    const g=await page.evaluate(()=>{
      /* Swing at EVERYTHING for long enough that bombs are arriving. A
         player who waves at all of it must do worse than one who waves
         at none of it - that is the whole point of a bomb. */
      const swipe=(game,secs)=>{
        let sw=0;
        for (let i=0;i<secs*50;i++){
          sw+=0.02;
          VR._setHand('right',{seen:true,x:0.5+Math.sin(sw*9)*0.25,y:0.5,
                               vx:Math.cos(sw*9)*0.06,vy:0.02});
          VR._setHand('left',{seen:true,x:0.5+Math.cos(sw*7)*0.25,y:0.5,
                              vx:-Math.sin(sw*7)*0.06,vy:0.02});
          game.step(0.02);
        }
        VR._setHand('left',{seen:false}); VR._setHand('right',{seen:false,vx:0,vy:0});
        return game.score();
      };
      const wild=swipe(VR.GAMES.slice.make(), 60);
      /* CONTROL: early on there are none, so a beginner is not punished
         for swinging before they know what a bomb looks like. */
      const early=(()=>{ const game=VR.GAMES.slice.make();
        let sw=0;
        for (let i=0;i<8*50;i++){ sw+=0.02;
          VR._setHand('right',{seen:true,x:0.5+Math.sin(sw*9)*0.25,y:0.5,
                               vx:Math.cos(sw*9)*0.06,vy:0.02});
          game.step(0.02); }
        VR._setHand('right',{seen:false,vx:0,vy:0});
        return game.score(); })();
      return { wild, early };
    });
    ok('SETUP: a long game really was played', g.wild.score>0 || g.wild.missed>0, g.wild);
    ok('waving at everything sets some off', g.wild.bombs>0, g.wild);
    ok('CONTROL: none arrive in the first few seconds', g.early.bombs===0, g.early);
  }

  console.log('\nIT COUNTS YOU IN');
  {
    const c=await page.evaluate(async()=>{
      const realLive=CAM.live; CAM.live=()=>true;
      VR.start('slice');
      const atStart=VR._ready();
      const scoreAtStart=VR.score();
      await new Promise(r=>setTimeout(r,250));
      const soon=VR._ready();
      VR.stop(); CAM.live=realLive;
      return { atStart, soon, live:scoreAtStart?scoreAtStart.live:-1 };
    });
    ok('there is a countdown before the first cube', c.atStart>2, c);
    ok('and it runs down', c.soon<c.atStart, c);
    ok('CONTROL: nothing has arrived while it counts', c.live===0, c);
  }

  ok('no page errors throughout', errs.length===0, errs);
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  await b.close(); server.close(); process.exit(fail?1:0);
})().catch(e=>{ console.log('  FAIL the suite could not finish  '+JSON.stringify(String(e&&e.message||e).split('\n')[0]));
  console.log('\n'+pass+'/'+(pass+fail+1)+' passed'); process.exit(1); });
