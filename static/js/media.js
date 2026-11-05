// Медиа: голосовые, кружки, фото, файлы — отображение, запись и отправка.
// Файлы в зашифрованных сообщениях скачиваются шифротекстом и расшифровываются прямо в браузере.
import { h, clear, icon, fmtDuration, fmtSize, toast, openModal } from './ui.js';
import { audioCtx, sounds } from './sounds.js';
import { mediaSrc } from './crypto.js';

const VOICE_MAX = 10 * 60;   // сек
const NOTE_MAX = 60;         // сек
const NOTE_SIZE = 480;       // px, квадрат кружка

let recording = false;

/** SVG из разметки (HTML-парсер сам кладёт <svg> в нужное пространство имён) */
function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

function pickMime(list) {
  if (!window.MediaRecorder) return null;
  return list.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function insecureHint() {
  toast(window.isSecureContext
    ? 'Браузер не поддерживает запись'
    : 'Микрофон и камера работают только по https или на localhost — откройте защищённую ссылку', 5000);
}

/* ============================================================ глобальный плеер голосовых */

const player = { audio: new Audio(), id: null, msg: null, rate: 1 };
player.audio.preload = 'auto';

const voiceEls = id => document.querySelectorAll(`.voice-msg[data-mid="${id}"]`);

function voiceDuration(m) {
  const d = player.audio.duration;
  return (m.meta && m.meta.duration) || (Number.isFinite(d) ? d : 0);
}

function refreshVoice(id) {
  const m = player.msg;
  for (const el of voiceEls(id)) {
    const active = player.id === id;
    const playing = active && !player.audio.paused;
    const dur = m && active ? voiceDuration(m) : Number(el.dataset.dur) || 0;
    const t = active ? player.audio.currentTime : 0;
    const frac = dur ? Math.min(1, t / dur) : 0;
    clear(el.querySelector('.vplay'), icon(playing ? 'pause' : 'play'));
    const bars = el.querySelectorAll('.wave i');
    bars.forEach((b, i) => b.classList.toggle('played', active && (i + 0.5) / bars.length <= frac));
    el.querySelector('.vtime').textContent = active && (playing || t > 0) ? fmtDuration(t) + ' / ' + fmtDuration(dur) : fmtDuration(dur);
    el.classList.toggle('active', active);
    el.querySelector('.vspeed').textContent = player.rate + 'x';
  }
}

['play', 'pause', 'timeupdate', 'ended', 'loadedmetadata'].forEach(ev => player.audio.addEventListener(ev, () => {
  if (player.id != null) refreshVoice(player.id);
}));

player.audio.addEventListener('ended', () => {
  const id = player.id;
  const els = [...document.querySelectorAll('.voice-msg')];
  const cur = els.findIndex(e => Number(e.dataset.mid) === id);
  player.audio.currentTime = 0;
  refreshVoice(id);
  // как в Telegram: следующее голосовое играет само
  const next = cur >= 0 ? els[cur + 1] : null;
  if (next && next._msg) setTimeout(() => playVoice(next._msg), 250);
});

async function playVoice(m, seekFrac) {
  if (player.id !== m.id) {
    const prev = player.id;
    pauseVideos();
    player.audio.pause();
    player.id = m.id;
    player.msg = m;
    if (prev != null) refreshVoice(prev);
    let url;
    try { url = await mediaSrc(m); } catch (e) { toast('Не удалось расшифровать голосовое'); return; }
    if (player.id !== m.id) return;          // пока расшифровывали, включили другое
    player.audio.src = url;
    player.audio.playbackRate = player.rate;
    player.audio.play().catch(() => toast('Не удалось воспроизвести'));
  } else if (seekFrac == null) {
    if (player.audio.paused) { pauseVideos(); player.audio.play(); } else player.audio.pause();
  }
  if (seekFrac != null) {
    const dur = voiceDuration(m);
    if (dur) { try { player.audio.currentTime = seekFrac * dur; } catch (e) { /* без индекса перемотка может не сработать */ } }
    if (player.audio.paused) player.audio.play();
  }
}

export function pauseAll() {
  player.audio.pause();
  pauseVideos();
}

function pauseVideos(except) {
  document.querySelectorAll('.vnote video, video.msg-video').forEach(v => { if (v !== except && !v.paused) v.pause(); });
}

function voicePlayer(m) {
  const wf = m.meta && m.meta.waveform && m.meta.waveform.length ? m.meta.waveform : Array(40).fill(18);
  const dur = (m.meta && m.meta.duration) || 0;
  const wave = h('div.wave', wf.map(v => h('i', { style: { height: Math.max(14, v) + '%' } })));
  const el = h('div.voice-msg', { dataset: { mid: m.id, dur } },
    h('button.vplay', { title: 'Слушать', onclick: e => { e.stopPropagation(); playVoice(m); } }, icon('play')),
    h('div.vbody',
      wave,
      h('div.vfoot',
        h('span.vtime', fmtDuration(dur)),
        h('button.vspeed', { title: 'Скорость', onclick: e => {
          e.stopPropagation();
          player.rate = player.rate === 1 ? 1.5 : player.rate === 1.5 ? 2 : 1;
          player.audio.playbackRate = player.rate;
          if (player.id != null) refreshVoice(player.id);
        } }, '1x'))));
  el._msg = m;
  wave.addEventListener('click', e => {
    e.stopPropagation();
    const r = wave.getBoundingClientRect();
    playVoice(m, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  });
  if (player.id === m.id) setTimeout(() => refreshVoice(m.id));
  return el;
}

/* ============================================================ кружки */

function videoNote(m) {
  const dur = (m.meta && m.meta.duration) || 0;
  const R = 47, C = 2 * Math.PI * R;
  const video = h('video', { preload: 'metadata', playsInline: true });
  // первый кадр как обложка; для зашифрованного кружка src появится после расшифровки
  video.addEventListener('loadedmetadata', () => { if (video.paused && !video.currentTime) video.currentTime = 0.05; }, { once: true });
  withSrc(m, url => { video.src = url; });
  const ring = svg(`<svg class="vnote-ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>`);
  const ringEl = ring.querySelector('circle');
  const playIc = h('div.vnote-play', icon('play'));
  const time = h('span.vnote-dur', fmtDuration(dur));
  const el = h('div.vnote', video, ring, playIc, time);

  const update = () => {
    const d = dur || (Number.isFinite(video.duration) ? video.duration : 0);
    const frac = d ? Math.min(1, video.currentTime / d) : 0;
    ringEl.setAttribute('stroke-dashoffset', String(C * (1 - frac)));
    // на паузе показываем длину кружка, во время просмотра — текущую секунду
    time.textContent = fmtDuration(video.paused ? d : video.currentTime);
  };
  video.addEventListener('timeupdate', update);
  video.addEventListener('play', () => { el.classList.add('playing'); playIc.hidden = true; });
  video.addEventListener('pause', () => { el.classList.remove('playing'); playIc.hidden = false; });
  video.addEventListener('ended', () => { video.currentTime = 0; update(); });
  el.addEventListener('click', e => {
    e.stopPropagation();
    if (video.paused) {
      player.audio.pause();
      pauseVideos(video);
      video.play().catch(() => toast('Не удалось воспроизвести'));
    } else video.pause();
  });
  return el;
}

/* ============================================================ фото и файлы */

/** Подставить адрес файла: обычный — сразу, зашифрованный — когда скачается и расшифруется */
function withSrc(m, apply) {
  mediaSrc(m).then(apply).catch(() => {});
}

export async function downloadMedia(m) {
  try {
    const url = await mediaSrc(m);
    const local = url.startsWith('blob:');
    const a = h('a', { href: local ? url : url + '?dl=1', download: (m.meta && m.meta.name) || 'file' });
    document.body.append(a);
    a.click();
    a.remove();
  } catch (e) { toast(e.message); }
}

function imageView(m) {
  const w = m.meta && m.meta.width, hgt = m.meta && m.meta.height;
  const img = h('img', { alt: '', loading: 'lazy' });
  img.addEventListener('load', () => img.classList.add('ready'), { once: true });
  withSrc(m, url => { img.src = url; });
  const wrap = h('div.msg-image', { onclick: e => { e.stopPropagation(); lightbox(m); } }, img);
  if (w && hgt) {
    const scale = Math.min(1, 380 / w, 420 / hgt);
    wrap.style.width = Math.max(140, Math.round(w * scale)) + 'px';
    wrap.style.aspectRatio = `${w} / ${hgt}`;
  }
  return wrap;
}

function lightbox(m) {
  const img = h('img', { alt: '' });
  withSrc(m, url => { img.src = url; });
  const close = () => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 160); document.removeEventListener('keydown', esc, true); };
  const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const wrap = h('div.lightbox', { onclick: close },
    img,
    h('div.lightbox-bar',
      h('button.icon-btn', { title: 'Скачать', onclick: e => { e.stopPropagation(); downloadMedia(m); } }, icon('download')),
      h('button.icon-btn', { title: 'Закрыть', onclick: close }, icon('x'))));
  document.addEventListener('keydown', esc, true);
  document.body.append(wrap);
}

function fileView(m) {
  const meta = m.meta || {};
  const name = meta.name || 'файл';
  const mime = meta.mime || '';
  const link = h('a.msg-file', { href: '#', onclick: e => { e.preventDefault(); e.stopPropagation(); downloadMedia(m); } },
    h('div.file-icon', icon('download')),
    h('div.file-info', h('div.file-name', name), h('div.file-size', fmtSize(meta.size || 0))));
  // встроенный плеер — для не слишком больших файлов: зашифрованное нужно скачать целиком
  const inline = (meta.size || 0) <= 60 * 1024 * 1024;
  if (inline && mime.startsWith('video/')) {
    const v = h('video.msg-video', { controls: true, preload: 'metadata', playsInline: true });
    withSrc(m, url => { v.src = url; });
    return h('div.file-media', v, link);
  }
  if (inline && mime.startsWith('audio/')) {
    const a = h('audio.msg-audio', { controls: true, preload: 'none' });
    withSrc(m, url => { a.src = url; });
    return h('div.file-media', a, link);
  }
  return link;
}

export function messageContent(m) {
  switch (m.kind) {
    case 'voice': return voicePlayer(m);
    case 'video_note': return videoNote(m);
    case 'image': return imageView(m);
    default: return fileView(m);
  }
}

/* ============================================================ отправка файлов */

const isImage = f => /^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(f.type);

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть картинку')); };
    img.src = url;
  });
}

/** Уменьшаем огромные фото (как мессенджеры): до 2560px по большей стороне */
async function prepareImage(file) {
  const { img, url } = await loadImage(file);
  try {
    let w = img.naturalWidth, hh = img.naturalHeight;
    const big = Math.max(w, hh) > 2560 || file.size > 2.5 * 1024 * 1024;
    if (file.type === 'image/gif' || !big) return { blob: file, width: w, height: hh };
    const k = Math.min(1, 2560 / Math.max(w, hh));
    w = Math.round(w * k); hh = Math.round(hh * k);
    const canvas = h('canvas', { width: w, height: hh });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, hh);
    ctx.drawImage(img, 0, 0, w, hh);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.87));
    return { blob: blob || file, width: w, height: hh };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Квадратная аватарка 512px из любой картинки */
export async function squareImage(file, size = 512) {
  const { img, url } = await loadImage(file);
  try {
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = h('canvas', { width: size, height: size });
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function sendFilesDialog(files, sendMedia) {
  files = files.slice(0, 20);
  const hasImages = files.some(isImage);
  const urls = [];
  const asFile = h('input', { type: 'checkbox' });
  const caption = h('input.field', { placeholder: 'Подпись', maxlength: 1000 });
  const grid = h('div.send-grid', files.map(f => {
    if (isImage(f)) {
      const u = URL.createObjectURL(f);
      urls.push(u);
      return h('div.send-thumb', h('img', { src: u, alt: '' }));
    }
    return h('div.send-file', h('div.file-icon', icon('file')), h('div.file-info', h('div.file-name', f.name), h('div.file-size', fmtSize(f.size))));
  }));
  const title = files.length === 1 ? (hasImages ? 'Отправить фото' : 'Отправить файл') : `Отправить ${files.length} файла(ов)`;
  const send = async () => {
    m.close();
    const cap = caption.value.trim();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const text = i === files.length - 1 ? cap : '';
      try {
        if (isImage(f) && !asFile.checked) {
          const p = await prepareImage(f);
          await sendMedia({ blob: p.blob, name: f.name, kind: 'image', meta: { width: p.width, height: p.height }, text });
        } else {
          await sendMedia({ blob: f, name: f.name, kind: 'file', text });
        }
      } catch (e) { toast(e.message); }
    }
  };
  const m = openModal({
    title, cls: 'wide',
    onClose: () => urls.forEach(u => URL.revokeObjectURL(u)),
    body: h('form.modal-form', { onsubmit: e => { e.preventDefault(); send(); } },
      grid,
      hasImages ? h('label.check-row', asFile, h('span', 'Отправить без сжатия, как файл')) : null,
      caption),
    actions: [{ label: 'Отмена', onclick: () => m.close() }, { label: 'Отправить', primary: true, onclick: send }],
  });
}

/* ============================================================ запись голосового */

function downsample(levels, n) {
  if (!levels.length) return Array(n).fill(10);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * levels.length / n), b = Math.max(a + 1, Math.floor((i + 1) * levels.length / n));
    let mx = 0;
    for (let j = a; j < b && j < levels.length; j++) mx = Math.max(mx, levels[j]);
    out.push(mx);
  }
  const peak = Math.max(...out, 0.02);
  return out.map(v => Math.round(Math.max(6, Math.min(100, Math.sqrt(v / peak) * 100))));
}

export async function recordVoice({ mount, hide, onSend, onTyping }) {
  if (recording) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return insecureHint();
  recording = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    recording = false;
    toast('Нет доступа к микрофону');
    return;
  }
  pauseAll();
  const mime = pickMime(['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

  const ctx = audioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const levels = [];

  const timeEl = h('span.rec-time', '0:00');
  const live = h('div.rec-wave', Array.from({ length: 36 }, () => h('i')));
  const bars = [...live.children];
  let sendOnStop = false;
  const finish = send => {
    if (rec.state === 'inactive') return;
    sendOnStop = send;
    rec.stop();
  };
  const cancelBtn = h('button.icon-btn.danger-text', { title: 'Удалить', onclick: () => finish(false) }, icon('trash'));
  const sendBtn = h('button.send-btn', { title: 'Отправить', onclick: () => finish(true) }, icon('send'));
  const ui = h('div.recorder', cancelBtn, h('span.rec-dot'), timeEl, live, sendBtn);
  hide.hidden = true;
  mount.append(ui);

  const started = performance.now();
  let lastTyping = 0;
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    levels.push(rms);
    const sec = (performance.now() - started) / 1000;
    timeEl.textContent = fmtDuration(sec);
    const recent = levels.slice(-bars.length);
    bars.forEach((b, i) => { const v = recent[i - (bars.length - recent.length)] || 0; b.style.height = Math.max(8, Math.min(100, Math.sqrt(v) * 260)) + '%'; });
    if (Date.now() - lastTyping > 3000) { lastTyping = Date.now(); onTyping && onTyping(); }
    if (sec >= VOICE_MAX) finish(true);
  }, 50);

  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
  };
  document.addEventListener('keydown', onKey, true);

  rec.onstop = () => {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey, true);
    stream.getTracks().forEach(t => t.stop());
    try { src.disconnect(); } catch (e) { /* ignore */ }
    ui.remove();
    hide.hidden = false;
    recording = false;
    if (!sendOnStop) return;
    const duration = (performance.now() - started) / 1000;
    if (duration < 0.7) { toast('Слишком короткое голосовое'); return; }
    const blob = new Blob(chunks, { type: (rec.mimeType || mime || 'audio/webm').split(';')[0] });
    onSend(blob, { duration: Math.round(duration * 10) / 10, waveform: downsample(levels, 48) });
  };
  rec.start(250);
  sounds.recStart();
}

/* ============================================================ запись кружка */

export async function recordVideoNote({ onSend, onTyping }) {
  if (recording) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return insecureHint();
  recording = true;
  let facing = 'user';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 640 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    recording = false;
    toast('Нет доступа к камере или микрофону');
    return;
  }
  pauseAll();

  // рисуем камеру в квадратный canvas и пишем уже его — так кружок всегда ровный,
  // а камеру можно переключать прямо во время записи
  const cam = h('video', { muted: true, playsInline: true, autoplay: true });
  cam.srcObject = new MediaStream(stream.getVideoTracks());
  cam.play().catch(() => {});
  const canvas = h('canvas.vrec-canvas', { width: NOTE_SIZE, height: NOTE_SIZE });
  const g = canvas.getContext('2d');
  let raf = 0;
  const draw = () => {
    const vw = cam.videoWidth, vh = cam.videoHeight;
    if (vw && vh) {
      const s = Math.min(vw, vh);
      g.save();
      if (facing === 'user') { g.translate(NOTE_SIZE, 0); g.scale(-1, 1); }
      g.drawImage(cam, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, NOTE_SIZE, NOTE_SIZE);
      g.restore();
    }
    raf = requestAnimationFrame(draw);
  };
  draw();

  const out = canvas.captureStream(30);
  stream.getAudioTracks().forEach(t => out.addTrack(t));
  const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
  const rec = new MediaRecorder(out, mime ? { mimeType: mime, videoBitsPerSecond: 1200000, audioBitsPerSecond: 64000 } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

  const R = 49, C = 2 * Math.PI * R;
  const ring = svg(`<svg class="vrec-ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>`);
  const ringCircle = ring.querySelector('circle');
  const timeEl = h('div.vrec-time', h('span.rec-dot'), h('span', '0:00'));
  let sendOnStop = false;
  const finish = send => { if (rec.state !== 'inactive') { sendOnStop = send; rec.stop(); } };

  let hasMany = false;
  try { hasMany = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').length > 1; } catch (e) { /* ignore */ }
  const switchBtn = h('button.round-btn', { title: 'Сменить камеру', hidden: !hasMany, onclick: async () => {
    const next = facing === 'user' ? 'environment' : 'user';
    try {
      const s2 = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next, width: { ideal: 640 }, height: { ideal: 640 } } });
      cam.srcObject.getTracks().forEach(t => t.stop());
      cam.srcObject = s2;
      cam.play().catch(() => {});
      facing = next;
    } catch (e) { toast('Не удалось переключить камеру'); }
  } }, icon('switchCam'));

  const overlay = h('div.vrec-overlay',
    h('div.vrec-stage', h('div.vrec-circle', canvas), ring),
    timeEl,
    h('div.vrec-actions',
      h('button.round-btn', { title: 'Отмена', onclick: () => finish(false) }, icon('x')),
      switchBtn,
      h('button.round-btn.send', { title: 'Отправить', onclick: () => finish(true) }, icon('send'))));
  document.body.append(overlay);

  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
  };
  document.addEventListener('keydown', onKey, true);

  const started = performance.now();
  let lastTyping = 0;
  const timer = setInterval(() => {
    const sec = (performance.now() - started) / 1000;
    timeEl.lastChild.textContent = fmtDuration(sec);
    ringCircle.setAttribute('stroke-dashoffset', String(C * (1 - Math.min(1, sec / NOTE_MAX))));
    if (Date.now() - lastTyping > 3000) { lastTyping = Date.now(); onTyping && onTyping(); }
    if (sec >= NOTE_MAX) finish(true);
  }, 100);

  rec.onstop = () => {
    clearInterval(timer);
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey, true);
    stream.getTracks().forEach(t => t.stop());
    if (cam.srcObject) cam.srcObject.getTracks().forEach(t => t.stop());
    out.getTracks().forEach(t => t.stop());
    overlay.classList.add('out');
    setTimeout(() => overlay.remove(), 180);
    recording = false;
    if (!sendOnStop) return;
    const duration = (performance.now() - started) / 1000;
    if (duration < 1) { toast('Слишком короткое видео'); return; }
    const blob = new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] });
    onSend(blob, { duration: Math.round(duration * 10) / 10, width: NOTE_SIZE, height: NOTE_SIZE });
  };
  rec.start(500);
  sounds.recStart();
}
