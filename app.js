import { CLIPS, InteractionFlow } from './flow.js?v=11';
const stage=document.querySelector('#stage'), videos=[...stage.querySelectorAll('video')];
const status=document.querySelector('#status');
let active=0, playbackToken=0, currentClip=null, stream, worker, initializing=false;
let ready=false, inFlight=false, frameTimer, camera, lastFrameTime=-1, initToken=0;
const showStatus=text=>{ status.textContent=text; status.hidden=!text; };

async function playClip(state) {
  if (state==='DEFAULT') return;
  const token=++playbackToken;
  const next=videos[1-active];
  next.pause(); next.classList.remove('active');
  next.src=new URL(`./media/${CLIPS[state]}`,import.meta.url).href;
  next.loop=state==='IDLE'; next.muted=true;
  next.onended=()=>{ if(token===playbackToken) flow.ended(state,performance.now()); };
  next.onerror=()=>{ if(token===playbackToken) showStatus('영상을 불러오지 못했어요. 리셋을 눌러 다시 시도해 주세요.'); };
  try {
    await next.play();
    if(token!==playbackToken) return;
    if(next.requestVideoFrameCallback) await new Promise(resolve=>next.requestVideoFrameCallback(resolve));
    if(token!==playbackToken) return;
    videos[active].pause(); videos[active].classList.remove('active');
    next.classList.add('active'); active=1-active; currentClip=state;
  } catch(error) {
    if(token===playbackToken && error.name!=='AbortError') showStatus('영상 재생을 시작하려면 리셋을 눌러 주세요.');
  }
}
let flow;
flow=new InteractionFlow(state=>queueMicrotask(()=>playClip(state)));

function stopVision() {
  initToken++; clearTimeout(frameTimer); worker?.terminate(); worker=null;
  stream?.getTracks().forEach(t=>t.stop()); stream=null;
  camera?.pause(); if(camera) camera.srcObject=null;
  ready=false; initializing=false; inFlight=false; lastFrameTime=-1;
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
    worker=new Worker(new URL('./vision-worker.js?v=11',import.meta.url));
    const timeout=setTimeout(()=>fail('웹캠 인식을 준비하지 못했어요. 리셋으로 다시 시도해 주세요.'),45000);
    function fail(message) { if(token!==initToken) return; clearTimeout(timeout); stopVision(); showStatus(message); }
    worker.onerror=error=>{ console.error('Vision worker',error); fail('웹캠 인식을 준비하지 못했어요. 리셋으로 다시 시도해 주세요.'); };
    worker.onmessage=({data})=>{
      if(token!==initToken) return;
      if(data.type==='ready') { clearTimeout(timeout); ready=true; initializing=false; showStatus(''); capture(); }
      else if(data.type==='result' && !document.hidden) { flow.tick(data); drawDebug(data); }
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
  if(document.hidden) { clearTimeout(frameTimer); videos[active].pause(); }
  else { if(currentClip&&flow.state!=='DEFAULT') videos[active].play().catch(()=>{}); schedule(); }
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
const KEYS={'1':'RSP','2':'HI','3':'PICTURE','4':'TOMATO'};
document.addEventListener('keydown',e=>{
  if(e.repeat||e.ctrlKey||e.metaKey||e.altKey) return;
  if(e.key==='d'||e.key==='D') { debug.hidden=!debug.hidden; if(debug.hidden) dctx.clearRect(0,0,debug.width,debug.height); }
  else if(KEYS[e.key]) flow.trigger(KEYS[e.key],performance.now());
});
window.addEventListener('pagehide',stopVision);
window.addEventListener('pageshow',event=>{ if(event.persisted) startVision(); });
startVision();
