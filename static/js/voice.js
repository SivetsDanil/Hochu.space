// Голос и видео: голосовые каналы в группах и звонки в личке. WebRTC mesh, сигналинг через сервер.
//
// Видео без пересогласования: у каждого соединения сразу есть «слот» под видео (transceiver),
// а включение камеры или экрана — это просто replaceTrack() в этом слоте.
import { S, on, emit, putUser, putChat, findTab, chatTitle, voiceTabs } from './store.js';
import { $, h, clear, icon, avatar, toast, openModal, fmtDuration, plural, isMobile } from './ui.js';
import { audioCtx, sounds, ring } from './sounds.js';
import { pauseAll } from './media.js';
import { signCall, verifyCall, callCode } from './crypto.js';

// STUN помогает пробить NAT напрямую; если не вышло — TURN с relay (выдаётся сервером, если туннель настроен)
const iceServers = () => [{ urls: 'stun:stun.l.google.com:19302' }, ...((S.server && S.server.ice) || [])];
const RING_TIMEOUT = 45000;
const BITRATE = { camera: 700_000, screen: 1_500_000 };
const canShareScreen = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !isMobile();

const V = {
  tab: null, chat: null, joining: false,
  stream: null, noMic: false,
  muted: false, deafened: false, mutedBeforeDeafen: false,
  video: null,               // 'camera' | 'screen' | null — что показываем мы
  videoTrack: null,
  facing: 'user',
  camCount: 0,
  focus: null,               // conn развёрнутой плитки
  peers: new Map(),          // conn -> {pc, chain, audio, video: MediaStream, vtx, state}
  videoEls: new Map(),       // conn -> <video>, чтобы не пересоздавать при перерисовке
  meterTimer: null, meterSrc: null, speaking: false,
  stopRing: null, ringTimer: null, callStart: null, peerJoined: false,
  incoming: null,            // {modal, tab, stopRing}
  lastCount: null,
};

export const inVoice = () => V.tab;

export function initVoice() {
  on('voice', onVoice);
  on('speaking', onSpeaking);
  // таймер звонка обновляем точечно, без перерисовки видео
  setInterval(() => {
    if (!V.callStart) return;
    const t = fmtDuration((Date.now() - V.callStart) / 1000);
    document.querySelectorAll('[data-call-timer]').forEach(el => { el.textContent = t; });
  }, 1000);
  window.addEventListener('beforeunload', () => { if (V.tab) S.sock.fire('voice.leave'); });
}

/* ============================================================ вход и выход */

export async function joinTab(tabId, opts = {}) {
  if (V.joining || V.tab === tabId) return;
  const { chat } = findTab(tabId);
  if (!chat) return;
  if (V.tab) await leave(true);
  V.joining = true;
  rerender();
  audioCtx();
  pauseAll();

  let stream = null;
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      toast('Нет доступа к микрофону — вы подключены как слушатель');
    }
  } else {
    toast('Микрофон и камера работают только по https или на localhost — вы подключены как слушатель', 5000);
  }

  V.stream = stream;
  V.noMic = !stream;
  V.tab = tabId;
  V.chat = chat.id;
  V.peerJoined = false;
  V.lastCount = null;
  V.callStart = chat.type === 'dm' ? null : Date.now();
  if (stream) startMeter(stream);
  applyState(false);
  try {
    const res = await S.sock.call('voice.join', {
      tab: tabId, muted: V.muted || V.noMic, deafened: V.deafened, video: opts.video ? 'camera' : null,
    });
    V.joining = false;
    for (const conn of res.peers) createPeer(conn, true);
    sounds.join();
    if (chat.type === 'dm' && !res.peers.length) {
      V.stopRing = ring(true);
      V.ringTimer = setTimeout(() => { if (!V.peerJoined && V.tab === tabId) { toast('Нет ответа'); leave(); } }, RING_TIMEOUT);
    } else if (chat.type === 'dm') {
      V.peerJoined = true;
      V.callStart = Date.now();
    }
    if (opts.video) await startVideo('camera');
  } catch (e) {
    V.joining = false;
    toast(e.message);
    await leave(true);
  }
  rerender();
}

export async function leave(silent) {
  if (!V.tab) return;
  for (const conn of [...V.peers.keys()]) closePeer(conn);
  if (V.stream) V.stream.getTracks().forEach(t => t.stop());
  stopLocalVideo();
  stopMeter();
  stopRinging();
  V.stream = null;
  V.tab = null;
  V.chat = null;
  V.noMic = false;
  V.speaking = false;
  V.callStart = null;
  V.peerJoined = false;
  V.lastCount = null;
  V.focus = null;
  V.videoEls.clear();
  if (!silent) sounds.leave();
  rerender();
  try { await S.sock.call('voice.leave'); } catch (e) { /* соединение могло пропасть */ }
}

function stopRinging() {
  if (V.stopRing) { V.stopRing(); V.stopRing = null; }
  clearTimeout(V.ringTimer);
  V.ringTimer = null;
}

export function startCall(chat, opts = {}) {
  const t = voiceTabs(chat)[0];
  if (!t) return;
  if (V.tab === t.id) {
    if (opts.video && V.video !== 'camera') startVideo('camera');
    return;
  }
  joinTab(t.id, opts);
}

/* ============================================================ микрофон и звук */

function sendState() {
  if (V.tab) S.sock.fire('voice.state', { muted: V.muted || V.noMic, deafened: V.deafened, video: V.video });
}

export function toggleMute() {
  if (V.tab && V.noMic) return;
  if (V.deafened) { V.deafened = false; V.muted = false; } else V.muted = !V.muted;
  applyState(true);
}

export function toggleDeafen() {
  if (!V.deafened) { V.mutedBeforeDeafen = V.muted; V.deafened = true; V.muted = true; }
  else { V.deafened = false; V.muted = V.mutedBeforeDeafen; }
  applyState(true);
}

function applyState(notify) {
  if (V.stream) V.stream.getAudioTracks().forEach(t => { t.enabled = !V.muted; });
  for (const p of V.peers.values()) if (p.audio) p.audio.muted = V.deafened;
  if (V.muted && V.speaking) { V.speaking = false; S.sock.fire('voice.speaking', { value: false }); }
  if (notify) sendState();
  rerender();
}

function startMeter(stream) {
  const ctx = audioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let lastLoud = 0;
  V.meterSrc = src;
  V.meterTimer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const now = performance.now();
    if (Math.sqrt(sum / buf.length) > 0.012 && !V.muted) lastLoud = now;
    const speaking = now - lastLoud < 280;
    if (speaking !== V.speaking) { V.speaking = speaking; S.sock.fire('voice.speaking', { value: speaking }); }
  }, 60);
}

function stopMeter() {
  clearInterval(V.meterTimer);
  V.meterTimer = null;
  if (V.meterSrc) { try { V.meterSrc.disconnect(); } catch (e) { /* ignore */ } }
  V.meterSrc = null;
}

/* ============================================================ камера и экран */

async function startVideo(kind) {
  if (!V.tab) return;
  if (!navigator.mediaDevices) { toast('Камера работает только по https или на localhost', 5000); return; }
  let track;
  try {
    if (kind === 'screen') {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      track = s.getVideoTracks()[0];
    } else {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: V.facing, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } },
      });
      track = s.getVideoTracks()[0];
      try { V.camCount = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').length; } catch (e) { /* ignore */ }
    }
  } catch (e) {
    if (kind === 'screen' && e.name === 'NotAllowedError') return; // человек сам нажал «Отмена»
    toast(kind === 'screen' ? 'Не удалось начать демонстрацию экрана' : 'Нет доступа к камере');
    return;
  }
  if (!V.tab) { track.stop(); return; }
  stopLocalVideo();
  track.contentHint = kind === 'screen' ? 'detail' : 'motion';
  // «Прекратить доступ» в панели браузера
  track.onended = () => { if (V.videoTrack === track) stopVideo(); };
  V.videoTrack = track;
  V.video = kind;
  for (const p of V.peers.values()) setPeerVideo(p);
  sendState();
  rerender();
}

function stopLocalVideo() {
  if (V.videoTrack) { V.videoTrack.onended = null; V.videoTrack.stop(); }
  V.videoTrack = null;
  V.video = null;
  V.videoEls.delete(S.conn);
}

export function stopVideo() {
  if (!V.video) return;
  stopLocalVideo();
  for (const p of V.peers.values()) setPeerVideo(p);
  sendState();
  rerender();
}

export const toggleCamera = () => (V.video === 'camera' ? stopVideo() : startVideo('camera'));
export const toggleScreen = () => (V.video === 'screen' ? stopVideo() : startVideo('screen'));

export function switchCamera() {
  if (V.video !== 'camera') return;
  V.facing = V.facing === 'user' ? 'environment' : 'user';
  startVideo('camera');
}

function setPeerVideo(p) {
  if (!p.vtx) return;
  p.vtx.sender.replaceTrack(V.videoTrack || null).then(() => tuneSender(p)).catch(console.warn);
}

/** Потолок битрейта, чтобы mesh не забивал сеть */
function tuneSender(p) {
  if (!p.vtx || !V.video) return;
  try {
    const params = p.vtx.sender.getParameters();
    if (!params.encodings || !params.encodings.length) return; // ещё не договорились — настроим после соединения
    params.encodings[0].maxBitrate = BITRATE[V.video];
    params.degradationPreference = V.video === 'screen' ? 'maintain-resolution' : 'balanced';
    p.vtx.sender.setParameters(params).catch(() => {});
  } catch (e) { /* не все браузеры дают менять параметры */ }
}

/* ============================================================ WebRTC */

function createPeer(conn, initiator) {
  if (V.peers.has(conn)) closePeer(conn);
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const peer = { pc, chain: Promise.resolve(), audio: null, video: null, vtx: null, state: 'new' };
  V.peers.set(conn, peer);
  if (V.stream) V.stream.getTracks().forEach(t => pc.addTrack(t, V.stream));
  else if (initiator) pc.addTransceiver('audio', { direction: 'recvonly' });
  if (initiator) {
    peer.vtx = pc.addTransceiver('video', { direction: 'sendrecv' });
    if (V.videoTrack) setPeerVideo(peer);
  }

  const signal = data => S.sock.fire('voice.signal', { to: conn, data });
  pc.onicecandidate = e => { if (e.candidate) signal({ candidate: e.candidate.toJSON() }); };
  pc.ontrack = e => {
    if (e.track.kind === 'video') {
      peer.video = new MediaStream([e.track]);
      V.videoEls.delete(conn);
      e.track.onunmute = () => rerender();
      rerender();
      return;
    }
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (!peer.audio) {
      peer.audio = new Audio();
      peer.audio.autoplay = true;
      $('#audio-sink').append(peer.audio);
    }
    peer.audio.srcObject = stream;
    peer.audio.muted = V.deafened;
    peer.audio.play().catch(() => toast('Нажмите в любом месте страницы, чтобы включить звук'));
  };
  pc.onconnectionstatechange = () => {
    if (peer.state === 'insecure') return;
    peer.state = pc.connectionState;
    if (pc.connectionState === 'connected') tuneSender(peer);
    if (pc.connectionState === 'failed' && initiator) {
      peer.chain = peer.chain.then(async () => {
        await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
        signal({ sdp: pc.localDescription.toJSON(), sig: await signCall(S.conn, conn, pc.localDescription) });
      }).catch(console.warn);
    }
    rerender();
  };
  if (initiator) {
    peer.chain = peer.chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      // подписываем DTLS-отпечатки: сервер не сможет незаметно подставить свои ключи
      signal({ sdp: pc.localDescription.toJSON(), sig: await signCall(S.conn, conn, pc.localDescription) });
    }).catch(console.warn);
  }
  return peer;
}

/** Чей это conn: участника нашей голосовой комнаты (событие о нём могло чуть запоздать) */
async function userOfConn(conn) {
  for (let i = 0; i < 20; i++) {
    const p = (S.voice.get(V.tab) || []).find(x => x.conn === conn);
    if (p) return p.user;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

async function updateCode(peer) {
  const pc = peer.pc;
  if (!pc.localDescription || !pc.remoteDescription) return;
  peer.code = await callCode(pc.localDescription.sdp, pc.remoteDescription.sdp);
  rerender();
}

export function onSignal({ from, data }) {
  if (!V.tab || !data) return;
  let peer = V.peers.get(from);
  if (!peer) {
    if (data.sdp && data.sdp.type === 'offer') peer = createPeer(from, false);
    else return;
  }
  const pc = peer.pc;
  peer.chain = peer.chain.then(async () => {
    if (data.sdp) {
      const uid = await userOfConn(from);
      if (!(await verifyCall(uid, from, S.conn, data.sdp, data.sig))) {
        peer.state = 'insecure';
        closePeer(from);
        toast('⚠️ Не удалось подтвердить ключ шифрования собеседника — соединение сброшено');
        rerender();
        return;
      }
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        // видео-слот пришёл в предложении: делаем его двусторонним, чтобы тоже могли показывать камеру
        if (!peer.vtx) {
          const t = pc.getTransceivers().find(x => x.receiver && x.receiver.track && x.receiver.track.kind === 'video');
          if (t) {
            t.direction = 'sendrecv';
            peer.vtx = t;
            if (V.videoTrack) await t.sender.replaceTrack(V.videoTrack);
          }
        }
        await pc.setLocalDescription(await pc.createAnswer());
        S.sock.fire('voice.signal', { to: from, data: {
          sdp: pc.localDescription.toJSON(), sig: await signCall(S.conn, from, pc.localDescription),
        } });
      }
      updateCode(peer);
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { /* устаревший кандидат */ }
    }
  }).catch(console.warn);
}

function closePeer(conn) {
  const p = V.peers.get(conn);
  if (!p) return;
  V.peers.delete(conn);
  V.videoEls.delete(conn);
  if (V.focus === conn) V.focus = null;
  try { p.pc.close(); } catch (e) { /* ignore */ }
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
}

/* ============================================================ события сервера */

function onVoice(d) {
  (d.parts || []).forEach(p => p.u && putUser(p.u));
  // входящий звонок: собеседник сбросил, пока мы думали, или мы ответили с другого устройства
  if (V.incoming && V.incoming.tab === d.tab) {
    const callerHere = d.parts.some(p => p.user !== S.me.id);
    const meHere = d.parts.some(p => p.user === S.me.id);
    if (!callerHere || meHere) closeIncoming(!callerHere && !meHere ? 'Пропущенный звонок' : null);
  }
  if (d.tab !== V.tab) return;
  const others = d.parts.filter(p => p.conn !== S.conn);
  // закрываем соединения с теми, кто вышел
  for (const conn of [...V.peers.keys()]) if (!others.some(p => p.conn === conn)) closePeer(conn);
  const { chat } = findTab(d.tab);
  if (chat && chat.type === 'dm') {
    const peerHere = others.some(p => p.user !== S.me.id);
    if (peerHere && !V.peerJoined) {
      V.peerJoined = true;
      V.callStart = Date.now();
      stopRinging();
      sounds.join();
    } else if (!peerHere && V.peerJoined) {
      toast('Звонок завершён');
      leave();
      return;
    }
  } else if (V.lastCount != null && others.length !== V.lastCount) {
    if (others.length > V.lastCount) sounds.join(); else sounds.leave();
  }
  V.lastCount = others.length;
  rerender();
}

function onSpeaking(d) {
  const parts = S.voice.get(d.tab);
  const p = parts && parts.find(x => x.conn === d.conn);
  if (p) p.speaking = d.value;
  document.querySelectorAll(`[data-speak="${d.conn}"]`).forEach(el => el.classList.toggle('speaking', d.value));
}

export async function onCall({ chat: chatId, tab, from, video }) {
  putUser(from);
  if (V.tab === tab || V.incoming) return;
  let chat = S.chats.get(chatId);
  if (!chat) {
    try { chat = putChat(await S.sock.call('chats.get', { id: chatId })); emit('chats'); } catch (e) { return; }
  }
  const stopRing = ring(false);
  const accept = withVideo => { closeIncoming(); joinTab(tab, { video: withVideo }); emit('open-chat', chat.id); };
  const decline = () => { S.sock.fire('call.decline', { tab }); closeIncoming(); };
  const modal = openModal({
    cls: 'call-modal',
    dismissable: false,
    body: h('div.incoming',
      h('div.incoming-avatar', avatar(from, { size: 96 })),
      h('div.incoming-name', from.name),
      h('div.incoming-sub', video ? 'Входящий видеозвонок…' : 'Входящий звонок…'),
      h('div.incoming-actions',
        h('button.round-btn.leave', { title: 'Отклонить', onclick: decline }, icon('hangup')),
        h('button.round-btn.accept', { title: video ? 'Ответить без видео' : 'Ответить', onclick: () => accept(false) }, icon('phone')),
        video ? h('button.round-btn.accept', { title: 'Ответить с видео', onclick: () => accept(true) }, icon('camera')) : null)),
  });
  V.incoming = { modal, tab, stopRing };
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(video ? 'Входящий видеозвонок' : 'Входящий звонок', { body: from.name, tag: 'call-' + tab }); } catch (e) { /* ignore */ }
  }
  setTimeout(() => { if (V.incoming && V.incoming.tab === tab) closeIncoming('Пропущенный звонок'); }, RING_TIMEOUT + 5000);
}

function closeIncoming(note) {
  if (!V.incoming) return;
  V.incoming.stopRing();
  V.incoming.modal.close();
  V.incoming = null;
  if (note) toast(note);
}

export function onCallDeclined({ tab }) {
  if (V.tab === tab) { toast('Звонок отклонён'); leave(); }
}

export function onCallCancel({ tab }) {
  if (V.incoming && V.incoming.tab === tab) closeIncoming();
}

export function onKicked() {
  if (V.tab) { toast('Вы отключены от голосового канала'); leave(true); }
}

/** После переподключения к серверу наша голосовая сессия на сервере пропала */
export function resetAfterReconnect() {
  if (V.tab) leave(true);
}

/* ============================================================ отрисовка */

function rerender() {
  renderPanel();
  emit('voice-ui');
}

/** Видеопоток участника, если он сейчас что-то показывает и нам есть что показать */
function streamFor(p) {
  if (!p.video) return null;
  if (p.conn === S.conn) return V.videoTrack ? new MediaStream([V.videoTrack]) : null;
  const peer = V.peers.get(p.conn);
  return peer && peer.video ? peer.video : null;
}

/** <video> для участника; один и тот же элемент живёт между перерисовками, поэтому картинка не мигает */
function videoEl(p) {
  const stream = streamFor(p);
  if (!stream) return null;
  const local = p.conn === S.conn;
  let v = V.videoEls.get(p.conn);
  const trackId = stream.getVideoTracks()[0] && stream.getVideoTracks()[0].id;
  if (!v || v.dataset.track !== trackId) {
    v = h('video.vid', { autoplay: true, playsInline: true, muted: true });
    v.srcObject = stream;
    v.dataset.track = trackId;
    V.videoEls.set(p.conn, v);
  }
  v.classList.toggle('mirror', local && p.video === 'camera' && V.facing === 'user');
  v.classList.toggle('contain', p.video === 'screen');
  return v;
}

function playVideos(container) {
  container.querySelectorAll('video.vid').forEach(v => { if (v.paused) v.play().catch(() => {}); });
}

/** Кнопки управления: mic, звук, камера, экран, смена камеры, выход. В узкой плашке слева — без экрана. */
function controls(big, narrow = false) {
  const cls = big ? 'round-btn' : 'icon-btn';
  return [
    h(`button.${cls}` + (V.muted ? '.off' : ''), { title: V.muted ? 'Включить микрофон' : 'Выключить микрофон', disabled: V.noMic, onclick: toggleMute }, icon(V.muted ? 'micOff' : 'mic')),
    h(`button.${cls}` + (V.deafened ? '.off' : ''), { title: V.deafened ? 'Включить звук' : 'Выключить звук', onclick: toggleDeafen }, icon(V.deafened ? 'headOff' : 'head')),
    h(`button.${cls}` + (V.video === 'camera' ? '.on' : ''), { title: V.video === 'camera' ? 'Выключить камеру' : 'Включить камеру', onclick: toggleCamera }, icon(V.video === 'camera' ? 'camera' : 'cameraOff')),
    canShareScreen() && !narrow ? h(`button.${cls}` + (V.video === 'screen' ? '.on' : ''), { title: V.video === 'screen' ? 'Остановить демонстрацию' : 'Демонстрация экрана', onclick: toggleScreen }, icon(V.video === 'screen' ? 'screenOff' : 'screen')) : null,
    big && V.video === 'camera' && V.camCount > 1 ? h(`button.${cls}`, { title: 'Сменить камеру', onclick: switchCamera }, icon('switchCam')) : null,
    h(`button.${cls}.leave`, { title: 'Отключиться', onclick: () => leave() }, icon('hangup')),
  ].filter(Boolean);
}

/** Плашка внизу левой колонки, пока мы в голосе (как в Discord) */
function renderPanel() {
  const el = $('#voice-panel');
  if (!el) return;
  if (!V.tab && !V.joining) { clear(el); el.hidden = true; return; }
  el.hidden = false;
  const { chat, tab } = findTab(V.tab);
  const pending = [...V.peers.values()].filter(p => p.state !== 'connected').length;
  const dm = chat && chat.type === 'dm';
  let status = V.joining ? 'Подключение…' : pending ? 'Соединение…' : 'Голос подключён';
  if (dm && !V.peerJoined && !V.joining) status = 'Вызов…';
  const where = chat ? (dm ? chatTitle(chat) : `${tab.name} · ${chatTitle(chat)}`) : '';
  const extra = V.video === 'screen' ? ' · показываете экран' : V.video === 'camera' ? ' · камера' : V.noMic ? ' · только слушаю' : '';
  clear(el,
    h('div.vp-info', { onclick: () => chat && emit('open-chat', chat.id) },
      h('div.vp-status' + (pending || V.joining || (dm && !V.peerJoined) ? '.warn' : ''), h('span.signal-dot'), status,
        V.callStart ? h('span.vp-time', { dataset: { callTimer: '' } }, fmtDuration((Date.now() - V.callStart) / 1000)) : null),
      h('div.vp-where', where + extra)),
    controls(false, true));
}

function tileFlags(p) {
  return [
    p.deafened ? icon('headOff', 'flag') : p.muted ? icon('micOff', 'flag') : null,
    p.video === 'screen' ? icon('screen', 'flag-on') : null,
  ];
}

/** Экран голосовой вкладки в группе */
export function renderStage(container, chat, tab) {
  const parts = S.voice.get(tab.id) || [];
  const here = V.tab === tab.id;
  const videoMode = here && parts.some(p => p.video);
  if (V.focus && !parts.some(p => p.conn === V.focus && p.video)) V.focus = null;
  const grid = h('div.stage-grid' + (videoMode ? '.video-mode' : '') + (videoMode && V.focus ? '.has-focus' : '') + (videoMode ? '.n' + Math.min(parts.length, 9) : ''));
  if (!parts.length) {
    grid.append(h('div.stage-empty', h('div.stage-empty-icon', icon('speaker')), h('div', 'В канале пока никого. Заходите первым!')));
  }
  for (const p of parts) {
    const u = p.u || S.users.get(p.user) || { name: '?' };
    const me = p.user === S.me.id && p.conn === S.conn;
    const peer = V.peers.get(p.conn);
    const connecting = here && !me && peer && peer.state !== 'connected';
    if (videoMode) {
      const vid = videoEl(p);
      const tile = h('div.vtile' + (p.speaking ? '.speaking' : '') + (V.focus === p.conn ? '.focused' : '') + (vid ? '.has-video' : ''), {
        dataset: { speak: p.conn },
        title: peer && peer.code ? 'Код шифрования с этим участником: ' + peer.code.join('') : '',
        onclick: () => { if (vid) { V.focus = V.focus === p.conn ? null : p.conn; emit('voice-ui'); } },
      },
      vid || h('div.vtile-avatar', avatar(u, { size: 76, speakId: p.conn })),
      h('div.vtile-label', tileFlags(p), h('span', u.name + (me ? ' (вы)' : '') + (p.video === 'screen' ? ' · экран' : ''))),
      connecting ? h('div.vtile-warn', peer.state === 'failed' ? 'нет связи' : 'соединение…') : null,
      vid ? h('button.vtile-full', { title: 'На весь экран', onclick: e => {
        e.stopPropagation();
        const t = e.currentTarget.closest('.vtile');
        if (document.fullscreenElement) document.exitFullscreen(); else if (t.requestFullscreen) t.requestFullscreen();
      } }, icon('expand')) : null);
      grid.append(tile);
      continue;
    }
    let status = null;
    if (p.deafened) status = h('span.tile-flag', icon('headOff'), 'звук выключен');
    else if (p.muted) status = h('span.tile-flag', icon('micOff'), 'микрофон выключен');
    if (p.video && !here) status = h('span.tile-flag.on', icon(p.video === 'screen' ? 'screen' : 'camera'), p.video === 'screen' ? 'показывает экран' : 'с камерой');
    if (connecting) status = h('span.tile-warn', peer.state === 'failed' ? 'нет связи' : 'соединение…');
    grid.append(h('div.tile' + (p.speaking ? '.speaking' : ''), {
      dataset: { speak: p.conn },
      title: peer && peer.code ? 'Код шифрования с этим участником: ' + peer.code.join('') : '',
    },
      avatar(u, { size: 84, speakId: p.conn }),
      h('div.tile-name', u.name + (me ? ' (вы)' : '')),
      h('div.tile-status', status)));
  }
  const actions = h('div.stage-actions');
  if (here) actions.append(...controls(true));
  else {
    actions.append(
      h('button.join-btn', { disabled: V.joining, onclick: () => joinTab(tab.id) },
        icon('phone'), V.joining ? 'Подключение…' : V.tab ? 'Перейти в этот канал' : 'Подключиться'),
      h('button.round-btn.join-video', { title: 'Подключиться с камерой', disabled: V.joining, onclick: () => joinTab(tab.id, { video: true }) }, icon('camera')));
  }
  const viewers = parts.filter(p => p.video).length;
  clear(container,
    h('div.stage' + (videoMode ? '.video-mode' : ''),
      h('div.stage-head',
        h('div.stage-title', icon('speaker'), tab.name),
        h('div.stage-sub', parts.length
          ? `${parts.length} ${plural(parts.length, 'участник', 'участника', 'участников')} в канале` + (viewers ? ` · ${viewers} с видео` : '')
          : 'Голосовой канал'),
        here ? h('div.stage-e2e', { title: 'Голос и видео идут напрямую между участниками и зашифрованы; ключи подписаны личными ключами' },
          '🔒 Сквозное шифрование') : null),
      grid,
      actions,
      !window.isSecureContext ? h('div.stage-hint', 'Браузер даёт микрофон и камеру только по https или на localhost — по этой ссылке вы сможете только слушать.') : null));
  playVideos(container);
}

/** Звонок в личке: компактная плашка, а если кто-то включил видео — окно с видео */
export function renderCallBar(container, chat) {
  if (!chat || chat.type !== 'dm') { clear(container); container.hidden = true; return; }
  const tab = voiceTabs(chat)[0];
  const parts = tab ? S.voice.get(tab.id) || [] : [];
  const here = tab && V.tab === tab.id;
  const peer = chat.peer;
  const peerPart = parts.find(p => p.user !== S.me.id);
  if (!here && !parts.length) { clear(container); container.hidden = true; return; }
  container.hidden = false;
  const timer = () => (V.callStart ? h('span', { dataset: { callTimer: '' } }, fmtDuration((Date.now() - V.callStart) / 1000)) : 'Соединение…');
  const status = here ? (V.peerJoined ? timer() : 'Вызов…') : 'Идёт звонок';

  const myPart = here ? parts.find(p => p.conn === S.conn) : null;
  const remoteVid = here && peerPart ? videoEl(peerPart) : null;
  const localVid = myPart ? videoEl(myPart) : null;
  // код шифрования звонка: у собеседника на экране должны быть те же эмодзи
  const rtc = here && peerPart ? V.peers.get(peerPart.conn) : null;
  const codeEl = rtc && rtc.code
    ? h('span.call-code', { title: 'Звонок защищён сквозным шифрованием. Сравните эмодзи с собеседником — они должны совпадать.' },
      '🔒 ' + rtc.code.join(''))
    : null;

  if (here && (remoteVid || localVid)) {
    clear(container, h('div.call-video',
      h('div.cv-main' + (peerPart && peerPart.speaking ? '.speaking' : ''), { dataset: { speak: peerPart ? peerPart.conn : '' } },
        remoteVid || h('div.cv-avatar', peer ? avatar(peer, { size: 110, speakId: peerPart ? peerPart.conn : null }) : null)),
      h('div.cv-top', h('div.cv-name', peer ? peer.name : ''), h('div.cv-status', status,
        peerPart && peerPart.muted ? icon('micOff', 'flag') : null), codeEl),
      localVid ? h('div.cv-pip', localVid) : null,
      h('div.cv-controls', controls(true))));
    playVideos(container);
    return;
  }

  clear(container, h('div.call-bar',
    peer ? avatar(peer, { size: 36, speakId: peerPart ? peerPart.conn : null }) : null,
    h('div.call-text', h('div.call-title', here ? 'Звонок' : `${peer ? peer.name : ''} звонит`), h('div.call-status', status,
      peerPart && peerPart.muted ? h('span.call-flag', icon('micOff')) : null,
      peerPart && peerPart.video && !here ? h('span.call-flag.on', icon('camera')) : null, codeEl)),
    here ? controls(false) : [
      h('button.primary-btn.green', { onclick: () => joinTab(tab.id) }, icon('phone'), 'Присоединиться'),
      h('button.icon-btn', { title: 'Присоединиться с камерой', onclick: () => joinTab(tab.id, { video: true }) }, icon('camera')),
    ]));
  if (peerPart && peerPart.speaking) container.querySelectorAll(`[data-speak="${peerPart.conn}"]`).forEach(el => el.classList.add('speaking'));
}
