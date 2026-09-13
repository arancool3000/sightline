/* "hand tracking is very bad, and it should move gyroscopically. games
    should have nice feel to them. also add vr button that makes whole
    thing 2 views"

   Four things, and each has one property that a do-nothing build fails:

   VR MODE      the WHOLE app in two views - so the camera AND the app's
                own drawing must reach both halves, and the flat chrome
                must be out of the way. A build that only splits the
                screen and shows nothing in it passes "there are two
                halves"; the discriminator is that both halves have the
                picture in them.
   GYRO         the world must stay where it is when the head turns. A
                build that ignores orientation passes "the game runs".
   FEEL         a hit must do something other than change a number.
   HANDS        covered in vr_test; here only the part VR mode touches. */
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
  await page.waitForFunction(()=>window.STEREO&&window.VR&&window.CMD&&window.CAM,null,{timeout:30000});
  await page.evaluate(()=>{ const g=document.getElementById('gate'); if(g){g.classList.add('hidden'); g.hidden=true;} });

  console.log('\nTHE WHOLE APP, IN TWO VIEWS');
  {
    const v=await page.evaluate(async()=>{
      const realLive=CAM.live; CAM.live=()=>true;

      /* Something recognisable in each source, so "did it reach both
         halves" is a question about pixels and not about faith. A green
         bar stands in for the camera and a magenta one for everything
         the app draws. */
      const shim=document.createElement('canvas'); shim.width=320; shim.height=240;
      const sc=shim.getContext('2d');
      sc.fillStyle='#00c853'; sc.fillRect(0,0,320,240);
      /* drawImage(video) with no stream draws nothing, so the compositor
         is handed the canvas in the video's place - carrying the same
         videoWidth the real element would, since that is what the
         compositor reads to decide the crop. */
      shim.videoWidth=320; shim.videoHeight=240;
      const realGet=document.getElementById.bind(document);
      document.getElementById=(id)=>id==='cam'?shim:realGet(id);

      const over=document.getElementById('overlay');
      over.width=400; over.height=390;
      const oc=over.getContext('2d');
      oc.clearRect(0,0,400,390);
      oc.fillStyle='#ff00ff'; oc.fillRect(0,0,400,60);          // a "label" band

      const started=STEREO.start();
      STEREO._size();
      STEREO._draw();
      const cv=document.getElementById('vrStereoCv');
      const c2=cv.getContext('2d');
      const at=(fx,fy)=>{ const d=c2.getImageData(Math.round(cv.width*fx),Math.round(cv.height*fy),1,1).data;
                          return [d[0],d[1],d[2]]; };
      /* A quarter and three quarters across is the middle of each eye. */
      const camL=at(0.25,0.62), camR=at(0.75,0.62);
      const ovL =at(0.25,0.06), ovR =at(0.75,0.06);

      const dockGone=getComputedStyle(document.getElementById('dock')).display==='none';
      const exitBtn=document.getElementById('vrStereoOut');
      const exitTall=exitBtn?exitBtn.getBoundingClientRect().height:0;
      const wasOn=STEREO.running();

      exitBtn.click();
      const gone=!document.getElementById('vrStereo') && !STEREO.running();
      const dockBack=getComputedStyle(document.getElementById('dock')).display!=='none';

      document.getElementById=realGet; CAM.live=realLive;
      return { started, wasOn, camL, camR, ovL, ovR, dockGone, exitTall, gone, dockBack };
    });
    const greenish=(c)=>c[1]>90 && c[1]>c[0]+40 && c[1]>c[2]+40;
    const pinkish =(c)=>c[0]>120 && c[2]>120 && c[1]<90;
    ok('SETUP: it starts and reports itself running', v.started===true && v.wasOn===true, v);
    ok('the camera reaches the LEFT eye', greenish(v.camL), v.camL);
    ok('and the RIGHT eye', greenish(v.camR), v.camR);
    ok('what the app draws reaches the left eye too', pinkish(v.ovL), v.ovL);
    ok('and the right', pinkish(v.ovR), v.ovR);
    ok('the flat chrome is out of the way', v.dockGone===true, v);
    ok('the way out is thumb-sized', v.exitTall>=44, v.exitTall);
    ok('and leaving puts the app back', v.gone===true && v.dockBack===true, v);
  }

  console.log('\nTHE BUTTON, AND SAYING IT');
  {
    const r=await page.evaluate(()=>({
      button: !!document.getElementById('railVR'),
      mode:  (CMD.match('vr mode')||{}).name,
      two:   (CMD.match('two views')||{}).name,
      leave: (CMD.match('leave vr')||{}).name,
      /* CONTROL: the game and the mode are different things and must not
         answer for each other. */
      game:  (CMD.match('play cube slice')||{}).name,
      notThis: !!CMD.match('what does vr mode look like on the other one')
    }));
    ok('there is a VR button', r.button===true, r);
    ok('and it can be said', r.mode==='vr mode' && r.two==='vr mode', r);
    ok('and left by voice', r.leave==='leave vr', r);
    ok('CONTROL: starting a game is still the game, not the mode', r.game==='play', r);
    ok('CONTROL: a question about VR is not a command', r.notThis===false, r);

    const nocam=await page.evaluate(()=>{
      const realLive=CAM.live; CAM.live=()=>false;
      const out=STEREO.start();
      CAM.live=realLive;
      return { out, root:!!document.getElementById('vrStereo') };
    });
    ok('CONTROL: with no camera it refuses instead of showing black', nocam.out===false && nocam.root===false, nocam);
  }

  console.log('\nTHE WORLD STAYS PUT WHEN THE HEAD TURNS');
  {
    const g=await page.evaluate(()=>{
      VR._setHead(0,0);
      const straight=VR._project({x:0,y:0,z:3},0,400,390);
      /* Look left: something dead ahead must move to the RIGHT of the
         view, because it has not moved and you have. */
      VR._setHead(0.4,0);
      const turned=VR._project({x:0,y:0,z:3},0,400,390);
      /* Look up: it must move DOWN. */
      VR._setHead(0,0.3);
      const lifted=VR._project({x:0,y:0,z:3},0,400,390);
      VR._setHead(0,0);
      const back=VR._project({x:0,y:0,z:3},0,400,390);

      /* And the orientation event itself must drive it, zeroed where the
         game started rather than at magnetic north. */
      VR._recentre();
      VR._tilt({alpha:100,beta:10,gamma:0});
      const first=VR._head();
      VR._tilt({alpha:130,beta:10,gamma:0});
      const swung=VR._head();
      VR._tilt({alpha:100,beta:40,gamma:0});
      const nodded=VR._head();
      /* CONTROL: an event with nothing in it must not throw the world. */
      VR._tilt({alpha:null,beta:null,gamma:null});
      const empty=VR._head();
      VR._setHead(0,0);
      return { straight, turned, lifted, back, first, swung, nodded, empty };
    });
    ok('SETUP: dead ahead is the middle of the view', Math.abs(g.straight.x-200)<1, g.straight);
    ok('turning your head left moves the world right', g.turned.x>g.straight.x+20, g);
    ok('looking up moves it down', g.lifted.y>g.straight.y+15, g);
    ok('CONTROL: head level puts it back exactly', Math.abs(g.back.x-g.straight.x)<0.01, g);
    ok('the first reading is where you are looking, not north',
       Math.abs(g.first.yaw)<0.001 && Math.abs(g.first.pitch)<0.001, g.first);
    ok('turning after that moves the yaw', Math.abs(g.swung.yaw)>0.4, g.swung);
    ok('and tilting moves the pitch', Math.abs(g.nodded.pitch)>0.4, g.nodded);
    ok('CONTROL: an empty orientation event changes nothing',
       g.empty.pitch===g.nodded.pitch && g.empty.yaw===g.nodded.yaw, g);
  }

  console.log('\nA HIT DOES SOMETHING');
  {
    const f=await page.evaluate(()=>{
      const buzzes=[]; const realVib=navigator.vibrate;
      try{ Object.defineProperty(navigator,'vibrate',{configurable:true,
        value:(v)=>{buzzes.push(v); return true;}}); }catch(e){}

      const before=VR._feel();
      /* Play the slice game with a swinging hand until something is cut. */
      const game=VR.GAMES.slice.make();
      let sw=0, cut=false;
      for (let i=0;i<600 && !cut;i++){
        sw+=0.02;
        VR._setHand('right',{seen:true,x:0.5+Math.sin(sw*9)*0.2,y:0.5,
                             vx:Math.cos(sw*9)*0.06,vy:0.02});
        VR._setHand('left',{seen:false});
        game.step(0.02);
        if (game.score().score>0) cut=true;
      }
      const after=VR._feel();
      /* And it must SETTLE - a flash that never fades is a broken screen. */
      for (let i=0;i<60;i++) VR._feelStep(0.05);
      const settled=VR._feel();
      VR._setHand('right',{seen:false,vx:0,vy:0});
      try{ Object.defineProperty(navigator,'vibrate',{configurable:true,value:realVib}); }catch(e){}
      return { before, after, settled, cut, buzzes:buzzes.length };
    });
    ok('SETUP: something really was cut', f.cut===true, f);
    ok('CONTROL: nothing was happening before it', f.before.flash===0 && f.before.pops===0, f.before);
    ok('a hit flashes the view', f.after.flash>0, f.after);
    ok('and kicks it', f.after.shake>0, f.after);
    ok('and leaves the score where the cut happened', f.after.pops>0, f.after);
    ok('and the phone buzzes', f.buzzes>0, f.buzzes);
    ok('CONTROL: and all of it fades', f.settled.flash===0 && f.settled.shake===0 && f.settled.pops===0, f.settled);
  }

  ok('no page errors throughout', errs.length===0, errs);

  await b.close(); server.close();
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  process.exit(fail?1:0);
})();
