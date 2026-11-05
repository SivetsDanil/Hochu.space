// Звуки интерфейса — синтезируются WebAudio, без файлов.

let ctx = null;

export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// браузер разрешает звук только после первого действия пользователя
['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => { try { audioCtx(); } catch (e) { /* ignore */ } }, { once: true, capture: true }));

function tone(freqs, { dur = 0.16, gap = 0, vol = 0.1, type = 'sine', at = 0 } = {}) {
  try {
    const c = audioCtx();
    let t = c.currentTime + at;
    for (const f of freqs) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      if (Array.isArray(f)) { o.frequency.setValueAtTime(f[0], t); o.frequency.exponentialRampToValueAtTime(f[1], t + dur); }
      else o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
      t += dur + gap;
    }
  } catch (e) { /* звук не критичен */ }
}

export const sounds = {
  message: () => tone([880, 1320], { dur: 0.09, gap: 0.01, vol: 0.06 }),
  join: () => tone([[520, 880]], { dur: 0.18, vol: 0.1 }),
  leave: () => tone([[660, 380]], { dur: 0.2, vol: 0.1 }),
  recStart: () => tone([[700, 1000]], { dur: 0.1, vol: 0.06 }),
  error: () => tone([300, 220], { dur: 0.12, vol: 0.07, type: 'triangle' }),
};

/** Зацикленный звук звонка; возвращает функцию остановки */
export function ring(outgoing) {
  let stopped = false;
  const play = () => {
    if (stopped) return;
    if (outgoing) tone([440, 440], { dur: 0.35, gap: 0.25, vol: 0.05 });
    else tone([660, 880, 660, 880], { dur: 0.12, gap: 0.04, vol: 0.09, type: 'triangle' });
  };
  play();
  const timer = setInterval(play, outgoing ? 3000 : 1800);
  return () => { stopped = true; clearInterval(timer); };
}
