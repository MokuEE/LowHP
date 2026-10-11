const $ = (s) => document.querySelector(s);
const video = $('#sourceVideo');
const overlay = $('#overlay');
const ctx = overlay.getContext('2d');
const analysis = $('#analysisCanvas');
const actx = analysis.getContext('2d', { willReadFrequently: true });
let stream = null, monitoring = false, frameId = null, audioCtx = null;
let roi = { x: .03, y: .79, w: .45, h: .09 };
let dragStart = null, previousHp = null, lastAlert = 0, lastFrame = performance.now();
let panStart = null;
const view = { zoom: 1, panX: 0, panY: 0 };
const STORAGE_KEY = 'hp-watch-settings-v1';

const state = {
  capture: $('#captureButton'), monitor: $('#monitorButton'), badge: $('#captureBadge'),
  status: $('#statusText'), lamp: $('#statusLamp'), hp: $('#hpValue'), latency: $('#latencyValue'), bar: $('#hpBar')
};

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      threshold: +$('#threshold').value, interval: +$('#interval').value,
      volume: +$('#volume').value, damageAlert: $('#damageAlert').checked,
      lowAlert: $('#lowAlert').checked, roi
    }));
    const note=$('#saveNote');note.textContent='設定已儲存於這台裝置';note.classList.add('saved');
    clearTimeout(saveSettings.timer);saveSettings.timer=setTimeout(()=>note.classList.remove('saved'),900);
  } catch { $('#saveNote').textContent='瀏覽器未允許儲存設定'; }
}
function loadSettings() {
  try {
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY));if(!saved)return;
    if(Number.isFinite(saved.threshold))$('#threshold').value=Math.max(5,Math.min(95,saved.threshold));
    if(Number.isFinite(saved.interval))$('#interval').value=Math.max(1,Math.min(10,saved.interval));
    if(Number.isFinite(saved.volume))$('#volume').value=Math.max(0,Math.min(1,saved.volume));
    if(typeof saved.damageAlert==='boolean')$('#damageAlert').checked=saved.damageAlert;
    if(typeof saved.lowAlert==='boolean')$('#lowAlert').checked=saved.lowAlert;
    if(saved.roi&&['x','y','w','h'].every(k=>Number.isFinite(saved.roi[k]))) roi={x:saved.roi.x,y:saved.roi.y,w:saved.roi.w,h:saved.roi.h};
    $('#thresholdValue').value=`${$('#threshold').value}%`;$('#intervalValue').value=`${$('#interval').value} 秒`;
    $('#saveNote').textContent='已載入上次儲存的設定';
  } catch { localStorage.removeItem(STORAGE_KEY); }
}
loadSettings();

function ensureAudio() { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); return audioCtx.resume(); }
function beep(kind = 'damage') {
  ensureAudio().then(() => {
    const now = audioCtx.currentTime;
    const tones = kind === 'low' ? [740, 520, 740] : [880, 620];
    tones.forEach((freq, i) => {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = 'square'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * .13);
      gain.gain.linearRampToValueAtTime(+$('#volume').value * .16, now + i * .13 + .012);
      gain.gain.exponentialRampToValueAtTime(.001, now + i * .13 + .105);
      osc.connect(gain).connect(audioCtx.destination); osc.start(now + i * .13); osc.stop(now + i * .13 + .12);
    });
  });
}

$('#threshold').addEventListener('input', e => { $('#thresholdValue').value = `${e.target.value}%`; saveSettings(); });
$('#interval').addEventListener('input', e => { $('#intervalValue').value = `${e.target.value} 秒`; saveSettings(); });
$('#volume').addEventListener('input',saveSettings);
$('#damageAlert').addEventListener('change',saveSettings);
$('#lowAlert').addEventListener('change',saveSettings);
$('#testSound').addEventListener('click', () => beep('low'));

state.capture.addEventListener('click', async () => {
  try {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false });
    video.srcObject = stream;
    await video.play(); await ensureAudio();
    resetView();
    $('#emptyState').hidden = true; state.badge.textContent = '畫面擷取中'; state.badge.classList.add('live');
    state.capture.querySelector('span').textContent = '重新選擇畫面'; state.monitor.disabled = false;
    resizeOverlay(); drawOverlay();
    stream.getVideoTracks()[0].addEventListener('ended', stopCapture);
  } catch (err) { if (err.name !== 'NotAllowedError') setStatus('無法擷取畫面', 'danger'); }
});

state.monitor.addEventListener('click', () => {
  monitoring = !monitoring; previousHp = null;
  state.monitor.textContent = monitoring ? '停止即時監控' : '啟動即時監控';
  state.monitor.classList.toggle('active', monitoring);
  setStatus(monitoring ? '即時監控中' : '監控已暫停', monitoring ? 'live' : '');
  if (monitoring) tick(); else cancelAnimationFrame(frameId);
});

function stopCapture() {
  monitoring = false; cancelAnimationFrame(frameId); stream = null; video.srcObject = null;
  $('#emptyState').hidden = false; state.badge.textContent = '尚未擷取'; state.badge.classList.remove('live');
  state.monitor.disabled = true; state.monitor.textContent = '啟動即時監控'; setStatus('等待設定', '');
}
function setStatus(text, mode) { state.status.textContent = text; state.lamp.className = `status-lamp ${mode}`; }
function resizeOverlay() { overlay.width = overlay.clientWidth * devicePixelRatio; overlay.height = overlay.clientHeight * devicePixelRatio; }
function viewRect(width = overlay.width, height = overlay.height) {
  const vr = video.videoWidth / video.videoHeight, cr = width / height;
  const baseW = cr > vr ? height * vr : width, baseH = cr > vr ? height : width / vr;
  return { w: baseW * view.zoom, h: baseH * view.zoom, x: (width - baseW * view.zoom) / 2 + view.panX * width, y: (height - baseH * view.zoom) / 2 + view.panY * height };
}
function applyView() {
  video.style.transform = `translate(${view.panX * overlay.clientWidth}px, ${view.panY * overlay.clientHeight}px) scale(${view.zoom})`;
  $('#zoomValue').textContent = `${Math.round(view.zoom * 100)}%`;
  drawOverlay();
}
function resetView() { view.zoom = 1; view.panX = 0; view.panY = 0; applyView(); }
function drawOverlay() {
  const w = overlay.width, h = overlay.height; ctx.clearRect(0,0,w,h);
  if (!video.videoWidth) return;
  const visible = viewRect(w, h);
  const r = {x:visible.x+roi.x*visible.w,y:visible.y+roi.y*visible.h,w:roi.w*visible.w,h:roi.h*visible.h};
  ctx.fillStyle='rgba(2,17,25,.48)'; ctx.fillRect(0,0,w,h); ctx.clearRect(r.x,r.y,r.w,r.h);
  ctx.strokeStyle='#37c2df';ctx.lineWidth=2*devicePixelRatio;ctx.setLineDash([8*devicePixelRatio,5*devicePixelRatio]);ctx.strokeRect(r.x,r.y,r.w,r.h);
  ctx.setLineDash([]);ctx.fillStyle='#37c2df';ctx.fillRect(r.x,r.y-19*devicePixelRatio,82*devicePixelRatio,19*devicePixelRatio);
  ctx.fillStyle='#071418';ctx.font=`bold ${10*devicePixelRatio}px sans-serif`;ctx.fillText('HP 偵測區域',r.x+7*devicePixelRatio,r.y-6*devicePixelRatio);
}

function pointerPos(e) {
  const bounds=overlay.getBoundingClientRect(), visible=viewRect(bounds.width,bounds.height);
  return {x:Math.max(0,Math.min(1,(e.clientX-bounds.left-visible.x)/visible.w)),y:Math.max(0,Math.min(1,(e.clientY-bounds.top-visible.y)/visible.h))};
}
overlay.addEventListener('pointerdown', e => {
  if(!stream)return;
  if(e.button===1){e.preventDefault();panStart={x:e.clientX,y:e.clientY,panX:view.panX,panY:view.panY};$('#stage').classList.add('panning');}
  else if(e.button===0) dragStart=pointerPos(e);
  else return;
  overlay.setPointerCapture(e.pointerId);
});
overlay.addEventListener('pointermove', e => {
  if(panStart){const bounds=overlay.getBoundingClientRect();view.panX=panStart.panX+(e.clientX-panStart.x)/bounds.width;view.panY=panStart.panY+(e.clientY-panStart.y)/bounds.height;applyView();return;}
  if(!dragStart)return;const p=pointerPos(e);roi={x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),w:Math.abs(p.x-dragStart.x),h:Math.abs(p.y-dragStart.y)};drawOverlay();
});
function endPointer(){
  panStart=null;$('#stage').classList.remove('panning');
  if(!dragStart)return;dragStart=null;roi.x=Math.max(0,Math.min(.98,roi.x));roi.y=Math.max(0,Math.min(.98,roi.y));roi.w=Math.max(.015,Math.min(1-roi.x,roi.w));roi.h=Math.max(.015,Math.min(1-roi.y,roi.h));drawOverlay();saveSettings();
}
overlay.addEventListener('pointerup',endPointer);overlay.addEventListener('pointercancel',endPointer);
overlay.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
overlay.addEventListener('wheel',e=>{
  if(!stream)return;e.preventDefault();
  const bounds=overlay.getBoundingClientRect(),mouseX=e.clientX-bounds.left,mouseY=e.clientY-bounds.top,old=viewRect(bounds.width,bounds.height);
  const imageX=(mouseX-old.x)/old.w,imageY=(mouseY-old.y)/old.h;
  const next=Math.max(1,Math.min(8,view.zoom*Math.exp(-e.deltaY*.0015)));
  if(next===view.zoom)return;view.zoom=next;
  const fresh=viewRect(bounds.width,bounds.height);
  view.panX+=(mouseX-(fresh.x+imageX*fresh.w))/bounds.width;view.panY+=(mouseY-(fresh.y+imageY*fresh.h))/bounds.height;applyView();
},{passive:false});
$('#resetView').addEventListener('click',resetView);
window.addEventListener('resize', () => { resizeOverlay(); applyView(); });

function estimateHp() {
  const vw=video.videoWidth,vh=video.videoHeight;if(!vw||!vh)return null;
  const x=Math.floor(roi.x*vw),y=Math.floor(roi.y*vh),w=Math.max(1,Math.floor(roi.w*vw)),h=Math.max(1,Math.floor(roi.h*vh));
  analysis.width=w;analysis.height=h;actx.drawImage(video,x,y,w,h,0,0,w,h);
  const data=actx.getImageData(0,0,w,h).data, cols=Math.min(w,220), scores=[];
  for(let cx=0;cx<cols;cx++){let red=0,total=0;const sx=Math.floor(cx*w/cols);for(let yy=0;yy<h;yy+=Math.max(1,Math.floor(h/20))){const i=(yy*w+sx)*4,r=data[i],g=data[i+1],b=data[i+2];if(r>75&&r>g*1.35&&r>b*1.2)red++;total++;}scores.push(red/total);}
  const active=scores.map(v=>v>.22);let first=active.indexOf(true),last=active.lastIndexOf(true);if(first<0)return 0;
  let end=first;for(let i=first;i<=last;i++){if(active[i])end=i;else if(i-end>Math.max(3,cols*.025))break;}
  return Math.max(0,Math.min(100,Math.round((end-first+1)/Math.max(1,cols-first)*100)));
}

function tick(now=performance.now()) {
  if(!monitoring)return; const hp=estimateHp(); const elapsed=now-lastFrame;lastFrame=now;
  if(hp!==null){state.hp.textContent=`${hp}%`;state.latency.textContent=`${Math.round(elapsed)} ms`;state.bar.style.width=`${hp}%`;state.bar.style.background=hp<=+$('#threshold').value?'#ca2d35':'#ecd32e';
    const damage=previousHp!==null&&previousHp-hp>=2, low=hp<=+$('#threshold').value, interval=+$('#interval').value*1000;
    if(damage&&$('#damageAlert').checked&&now-lastAlert>700){beep('damage');lastAlert=now;}
    if(low&&$('#lowAlert').checked&&now-lastAlert>interval){beep('low');lastAlert=now;}
    setStatus(low?'低血量警告':'即時監控中',low?'danger':'live');previousHp=hp;
  } frameId=requestAnimationFrame(tick);
}
