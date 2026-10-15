import { CLIPS, InteractionFlow } from './flow.js?v=20';
const stage=document.querySelector('#stage'), screen=document.querySelector('#screen'), sctx=screen.getContext('2d');
const status=document.querySelector('#status');
let playbackToken=0, currentClip=null, stream, worker, initializing=false;
let ready=false, inFlight=false, frameTimer, camera, lastFrameTime=-1, initToken=0;
const showStatus=text=>{ status.textContent=text; status.hidden=!text; };

// Every clip is preloaded in its own <video> under the canvas. The canvas only
// ever shows frames that were actually decoded, and keeps the last one while
// the next clip starts, so a clip switch can never flash black or blank.
const clips={};
for(const [state,file] of Object.entries(CLIPS)) {
  const v=document.createElement('video');
  v.muted=true; v.playsInline=true; v.preload='auto'; v.disablePictureInPicture=true;
  v.setAttribute('disableremoteplayback','');
  v.src=new URL(`./media/${file}?v=31`,import.meta.url).href;
  stage.insertBefore(v,screen); clips[state]=v;
}
let shown=null;
sctx.fillStyle='#fff'; sctx.fillRect(0,0,screen.width,screen.height);
let lastPaint=0;
function paint() { if(shown&&shown.readyState>=2) sctx.drawImage(shown,0,0,screen.width,screen.height); lastPaint=performance.now(); }
(function loop() { paint(); requestAnimationFrame(loop); })();
// Some embedded/TV browsers throttle animation frames; keep painting anyway.
setInterval(()=>{ if(performance.now()-lastPaint>100) paint(); },33);
// Resolves once the clip has a decoded frame to show (frame callback where
// supported, with a polling fallback for browsers that throttle it).
const firstFrame=v=>new Promise(resolve=>{
  let done=false; const finish=()=>{ if(!done){ done=true; resolve(); } };
  v.requestVideoFrameCallback?.(finish);
  const check=()=>{ if(done) return; if(v.readyState>=2&&v.currentTime>0.03) finish(); else setTimeout(check,15); };
  check();
});

async function playClip(state) {
  if (state==='DEFAULT') return;
  // Let the idle loop play to its end; its 'ended' event starts onboarding.
  if (state==='WAKING') {
    const idle=clips.IDLE;
    if(shown!==idle||idle.ended) flow.ended('IDLE',performance.now());
    else idle.loop=false;
    return;
  }
  const token=++playbackToken;
  const next=clips[state];
  next.loop=state==='IDLE';
  next.onended=()=>{ if(token===playbackToken) flow.ended(state,performance.now()); };
  next.onerror=()=>{ if(token===playbackToken) showStatus('영상을 불러오지 못했어요. 리셋을 눌러 다시 시도해 주세요.'); };
  try {
    if(next.currentTime>0) next.currentTime=0;
    await next.play();
    if(token!==playbackToken) return;
    await firstFrame(next);
    if(token!==playbackToken) return;
    const prev=shown; shown=next; currentClip=state;
    if(prev&&prev!==next) prev.pause();
  } catch(error) {
    if(token===playbackToken && error.name!=='AbortError') showStatus('영상 재생을 시작하려면 리셋을 눌러 주세요.');
  }
}
// Guide text (Figma: DDP 영디자이너, node 10222:1338) shown above the robot's head.
const HINTS={
  IDLE:{sub:'Miro와 놀아볼까요?',title:'선 앞에서 카메라를 바라봐 주세요'},
  WAKING:{sub:'Miro가 물을 주고 있어요',title:'하던 일을 마치고 금방 돌아올 거예요!'},
};
const CARDS=[
  {icon:'point.png',sub:'Miro와 가위바위보를 해볼까요?',title:'카메라를 향해 검지 하나를 펴 보세요!'},
  {icon:'wave.png',sub:'Miro에게 인사해볼까요?',title:'카메라를 향해 손을 흔들어 보세요!'},
  {icon:'v.png',sub:'Miro가 무슨 포즈를 할까요?',title:'카메라를 향해 V 해보세요!'},
  {icon:'finger-heart.svg',sub:'Miro가 어떤 걸 가져다 줄까요?',title:'카메라를 향해 하트를 해보세요!'},
];
const CARD_MS=3000;
const frameEl=document.querySelector('#frame'), hintEl=document.querySelector('#hint');
const hintIcon=document.querySelector('#hint-icon'), hintSub=document.querySelector('#hint-sub'), hintTitle=document.querySelector('#hint-title');
CARDS.forEach(c=>{ new Image().src=`./guide/${c.icon}`; });
let hintKey=null, hintSwap, cardTimer, cardIndex=0;
function fitFrame() {
  const w=stage.clientWidth, h=stage.clientHeight, fw=Math.min(w,h*9/16), fh=fw*16/9;
  Object.assign(frameEl.style,{left:`${(w-fw)/2}px`,top:`${(h-fh)/2}px`,width:`${fw}px`,height:`${fh}px`});
  frameEl.style.setProperty('--u',`${fw/1080}px`);
}
new ResizeObserver(fitFrame).observe(stage); fitFrame();
function showHint(hint) {
  const key=hint?`${hint.icon||''}|${hint.title}`:null;
  if(key===hintKey) return;
  hintKey=key; clearTimeout(hintSwap);
  hintEl.classList.remove('show');
  if(!hint) return;
  // Fade out, swap the text, fade back in.
  hintSwap=setTimeout(()=>{
    hintIcon.hidden=!hint.icon; if(hint.icon) hintIcon.src=`./guide/${hint.icon}`;
    hintSub.textContent=hint.sub; hintTitle.textContent=hint.title;
    hintEl.classList.add('show');
  },hintEl.textContent.trim()?450:0);
}
function updateHint(state) {
  clearInterval(cardTimer);
  if(HINTS[state]) showHint(HINTS[state]);
  else if(state==='DEFAULT') {
    showHint(CARDS[cardIndex]);
    cardTimer=setInterval(()=>{ cardIndex=(cardIndex+1)%CARDS.length; showHint(CARDS[cardIndex]); },CARD_MS);
  } else showHint(null);
}
let flow;
flow=new InteractionFlow(state=>{ updateHint(state); queueMicrotask(()=>playClip(state)); });
window.__miro={flow,clips}; // console access for testing

function stopVision() {
  initToken++; clearTimeout(frameTimer); worker?.terminate(); worker=null;
  stream?.getTracks().forEach(t=>t.stop()); stream=null;
  camera?.pause(); if(camera) camera.srcObject=null;
  ready=false; initializing=false; inFlight=false; lastFrameTime=-1;
  document.querySelector('#cam').hidden=true;
}
async function startVision() {
  if(initializing || ready) return;
  initializing=true;
  const token=++initToken;
  try {
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('secure-context');
    const newStream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'},audio:false});
    if(token!==initToken) { newStream.getTracks().forEach(t=>t.stop()); return; }
    stream=newStream;
    camera=document.createElement('video'); camera.muted=true; camera.playsInline=true; camera.srcObject=stream;
    await camera.play();
    if(token!==initToken) return;
    worker=new Worker(new URL('./vision-worker.js?v=33',import.meta.url));
    const timeout=setTimeout(()=>fail('웹캠 인식을 준비하지 못했어요. 리셋으로 다시 시도해 주세요.'),45000);
    function fail(message) { if(token!==initToken) return; clearTimeout(timeout); stopVision(); showStatus(message); }
    worker.onerror=error=>{ console.error('Vision worker',error); fail('웹캠 인식을 준비하지 못했어요. 리셋으로 다시 시도해 주세요.'); };
    worker.onmessage=({data})=>{
      if(token!==initToken) return;
      if(data.type==='ready') { clearTimeout(timeout); ready=true; initializing=false; showStatus(''); capture(); }
      else if(data.type==='result' && !document.hidden) { flow.tick(data); drawDebug(data); drawCam(data); }
      else if(data.type==='frame-done') { inFlight=false; schedule(); }
      else if(data.type==='error' || data.type==='frame-error') { console.error('Recognition',data.message); fail('웹캠 인식 오류가 생겼어요. 리셋으로 다시 시도해 주세요.'); }
    };
    stream.getVideoTracks()[0].addEventListener('ended',()=>fail('웹캠 연결이 끊겼어요. 연결 후 리셋을 눌러 주세요.'),{once:true});
    worker.postMessage({type:'init'});
  } catch(error) {
    if(token!==initToken) return;
    stopVision();
    const messages={
      NotAllowedError:'웹캠을 허용한 뒤 리셋을 눌러 주세요.',
      NotFoundError:'웹캠을 연결한 뒤 리셋을 눌러 주세요.',
      NotReadableError:'다른 앱에서 웹캠을 사용 중이에요. 종료한 뒤 리셋을 눌러 주세요.',
      'secure-context':'HTTPS 또는 localhost에서 열어 주세요.'
    };
    showStatus(messages[error.name]||messages[error.message]||'웹캠을 시작하지 못했어요. 리셋을 눌러 다시 시도해 주세요.');
  }
}
function schedule() { clearTimeout(frameTimer); if(ready&&!document.hidden) frameTimer=setTimeout(capture,30); }
async function capture() {
  if(!ready||inFlight||document.hidden) return;
  if(camera.readyState<2||camera.currentTime===lastFrameTime) { schedule(); return; }
  lastFrameTime=camera.currentTime; inFlight=true;
  const target=worker;
  try {
    const height=Math.round(640*camera.videoHeight/camera.videoWidth);
    const frame=await createImageBitmap(camera,{resizeWidth:640,resizeHeight:height});
    if(!ready||worker!==target) { frame.close(); inFlight=false; return; }
    target.postMessage({type:'frame',at:performance.now(),frame},[frame]);
  } catch(error) { inFlight=false; schedule(); }
}
document.querySelector('#reset').addEventListener('click',()=>{
  showStatus(''); flow.reset(performance.now()); worker?.postMessage({type:'reset'});
  if(!ready) { stopVision(); startVision(); }
});
document.querySelector('#fullscreen').addEventListener('click',async()=>{
  try { await stage.requestFullscreen({navigationUI:'hide'}); }
  catch { showStatus('이 브라우저에서는 전체화면을 사용할 수 없어요. Chrome 또는 Edge에서 열어 주세요.'); }
});
document.addEventListener('visibilitychange',()=>{
  flow.suspend();
  if(document.hidden) { clearTimeout(frameTimer); shown?.pause(); }
  else { if(currentClip&&flow.state!=='DEFAULT') shown?.play().catch(()=>{}); schedule(); }
});
// Hidden helpers (not visible in fullscreen):
//   D = camera/recognition debug view, 1-4 = play RSP/HI/PICTURE/TOMATO manually.
const debug=document.querySelector('#debug'), dctx=debug.getContext('2d');
const BONES=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function drawDebug(r) {
  if(debug.hidden||!camera) return;
  const w=debug.width=camera.videoWidth/2, h=debug.height=camera.videoHeight/2;
  dctx.save(); dctx.translate(w,0); dctx.scale(-1,1); dctx.drawImage(camera,0,0,w,h);
  dctx.strokeStyle='#00e0ff'; dctx.lineWidth=2;
  for(const p of r.hands) for(const [a,b] of BONES) { dctx.beginPath(); dctx.moveTo(p[a][0]*w,p[a][1]*h); dctx.lineTo(p[b][0]*w,p[b][1]*h); dctx.stroke(); }
  dctx.restore();
  dctx.fillStyle='#000a'; dctx.fillRect(0,0,w,58); dctx.fillStyle='#fff'; dctx.font='12px system-ui';
  dctx.fillText(`state ${flow.state} · face ${r.present?'O':'X'} · look ${r.attentive?'O':'X'}`,8,16);
  dctx.fillText(`pose ${r.poses.map(p=>p??'-').join(' / ')||'-'} · ${r.labels.join(' / ')}`,8,34);
  dctx.fillStyle=r.gesture?'#7CFC00':'#fff'; dctx.fillText(`gesture ${r.gesture??'-'}`,8,52);
}
// On-screen mirror: camera image plus the hand skeleton the recognizer sees.
const cam=document.querySelector('#cam'), cctx=cam.getContext('2d');
function drawCam(r) {
  if(!camera||camera.readyState<2) return;
  cam.hidden=false;
  const w=cam.width, h=cam.height, vw=camera.videoWidth, vh=camera.videoHeight;
  // Cover-crop the camera into the box, mirrored like a mirror.
  const scale=Math.max(w/vw,h/vh), dw=vw*scale, dh=vh*scale, ox=(w-dw)/2, oy=(h-dh)/2;
  cctx.save(); cctx.translate(w,0); cctx.scale(-1,1);
  cctx.drawImage(camera,ox,oy,dw,dh);
  cctx.lineCap='round'; cctx.lineWidth=3;
  for(const p of r.hands) {
    cctx.strokeStyle='#ffffff'; cctx.globalAlpha=.9;
    for(const [a,b] of BONES) { cctx.beginPath(); cctx.moveTo(ox+p[a][0]*dw,oy+p[a][1]*dh); cctx.lineTo(ox+p[b][0]*dw,oy+p[b][1]*dh); cctx.stroke(); }
    cctx.fillStyle=r.gesture?'#6be06b':'#4aa3ff';
    for(const q of p) { cctx.beginPath(); cctx.arc(ox+q[0]*dw,oy+q[1]*dh,3.2,0,Math.PI*2); cctx.fill(); }
  }
  cctx.restore(); cctx.globalAlpha=1;
  cam.classList.toggle('active',!!r.gesture);
}
const KEYS={'1':'RSP','2':'HI','3':'PICTURE','4':'TOMATO'};
document.addEventListener('keydown',e=>{
  if(e.repeat||e.ctrlKey||e.metaKey||e.altKey) return;
  if(e.key==='d'||e.key==='D') { debug.hidden=!debug.hidden; if(debug.hidden) dctx.clearRect(0,0,debug.width,debug.height); }
  else if(KEYS[e.key]) flow.trigger(KEYS[e.key],performance.now());
});
window.addEventListener('pagehide',stopVision);
window.addEventListener('pageshow',event=>{ if(event.persisted) startVision(); });
startVision();
