// Анимированные смайлики, как в Telegram: большие эмодзи в сообщении «оживают», когда приходят (сердце бьётся,
// смайлик хохочет, рука машет), а по нажатию разлетаются частицами — сердечками, конфетти, искрами.
// Свои анимации поверх системных эмодзи: без сторонних библиотек и загрузок с чужих серверов.
import { h } from './ui.js';

const KINDS = {
  beat: '❤️🧡💛💚💙💜🖤🤍🤎💖💗💓💞💕❣️♥️💘',
  laugh: '😂🤣😆😄😁😃😀😅😹😝😜',
  love: '😍🥰😘😻💋',
  pop: '👍👎👌✌️🤝🙏💪🤞',
  clap: '👏🙌',
  wave: '👋🤚',
  flame: '🔥',
  party: '🎉🥳🎊🎈🎁🍾',
  shock: '😮😱😲🤯😳🙀',
  sad: '😢😭🥲😔😞😿',
  think: '🤔🧐🤨',
  rocket: '🚀',
  spin: '⭐🌟✨💫',
  cool: '😎🤩😏',
  angry: '😡🤬😠👿',
  sleepy: '😴🥱💤',
};
// частицы, которые разлетаются по нажатию
const PARTICLES = { beat: '❤️', love: '💕', party: 'confetti', flame: '🔥', laugh: '😂', clap: '✨', spin: '✨', sad: '💧', angry: '💢', rocket: '✨', pop: '✨', cool: '✨' };
const CONFETTI = ['#ff5e7e', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff9f1c'];

const GRAPHEME = /\p{Regional_Indicator}{2}|\p{Extended_Pictographic}️?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*|[0-9#*]️?⃣|\s+|./gsu;
const norm = g => g.replace(/️/g, '');
const KIND_OF = new Map();
for (const [kind, list] of Object.entries(KINDS)) for (const g of list.match(GRAPHEME)) KIND_OF.set(norm(g), kind);

export const emojiKind = g => KIND_OF.get(norm(g)) || 'float';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Содержимое сообщения из одних эмодзи: каждый — отдельный «живой» элемент */
export function emojiMessage(text) {
  return h('div.msg-emoji', (text.match(GRAPHEME) || []).map(g => {
    if (/^\s+$/.test(g)) return g;
    const kind = emojiKind(g);
    return h('span.ae.ae-' + kind, { onclick: e => { e.stopPropagation(); play(e.currentTarget); burst(e.currentTarget, g, kind); } }, g);
  }));
}

function play(el) {
  if (reduced()) return;
  el.classList.remove('play');
  void el.offsetWidth;               // перезапуск CSS-анимации
  el.classList.add('play');
  el.addEventListener('animationend', () => el.classList.remove('play'), { once: true });
}

/** «Оживить» все эмодзи внутри элемента — когда сообщение пришло или чат только открыли */
export function playEmoji(root) {
  root.querySelectorAll('.ae').forEach(play);
}

/** Разлёт частиц из точки: сердечки, конфетти, искры… */
export function burstAt(rect, g, kind = emojiKind(g), count = 14) {
  if (reduced()) return;
  const layer = h('div.fx-layer');
  document.body.append(layer);
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const kindP = PARTICLES[kind];
  for (let i = 0; i < count; i++) {
    const confetti = kindP === 'confetti';
    const el = confetti
      ? h('i.fx-p.fx-confetti', { style: { background: CONFETTI[i % CONFETTI.length] } })
      : h('i.fx-p', kindP || g);
    layer.append(el);
    // веер вверх с разбросом: частицы летят, крутятся и тают
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
    const dist = 70 + Math.random() * 150;
    const dx = Math.cos(angle) * dist, dy = Math.sin(angle) * dist;
    const size = confetti ? 1 : 0.5 + Math.random() * 0.7;
    const rot = (Math.random() - 0.5) * (confetti ? 720 : 120);
    el.animate([
      { transform: `translate(${cx}px, ${cy}px) translate(-50%, -50%) scale(${size * 0.3})`, opacity: 1 },
      { transform: `translate(${cx + dx * 0.7}px, ${cy + dy * 0.7}px) translate(-50%, -50%) scale(${size}) rotate(${rot * 0.6}deg)`, opacity: 1, offset: 0.6 },
      { transform: `translate(${cx + dx}px, ${cy + dy + (confetti ? 60 : 30)}px) translate(-50%, -50%) scale(${size * 0.8}) rotate(${rot}deg)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 600, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
  }
  setTimeout(() => layer.remove(), 1700);
}

export const burst = (el, g, kind) => burstAt(el.getBoundingClientRect(), g, kind);
