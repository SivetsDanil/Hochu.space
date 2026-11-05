// Темы оформления чатов: палитра пузырей, акцент, фон со свечением и узором — отдельно для тёмного и светлого режима.
// Тема ставится на область чата через CSS-переменные, поэтому боковая панель остаётся в общей теме приложения.
import { S, isAdmin } from './store.js';
import { $, h, toast, openModal } from './ui.js';

const P = (base, glow1, glow2, pat, own, text, meta, accent, inBubble) => ({ base, glow1, glow2, pat, own, text, meta, accent, inBubble });

export const THEMES = [
  { id: 'classic', name: 'Классика', pattern: 'dots',
    dark: P('#0e1621', 'rgba(94,181,247,.07)', 'rgba(79,206,110,.05)', ['#ffffff', 0.028], ['#2b5278', '#2b5278'], '#ffffff', 'rgba(200,225,255,.62)', '#5eb5f7', '#182533'),
    light: P('#dbe3ea', 'rgba(51,144,236,.10)', 'rgba(120,200,120,.12)', ['#1e3c5a', 0.05], ['#e3f5d1', '#e3f5d1'], '#0f1419', '#4fa35a', '#3390ec', '#ffffff') },
  { id: 'ocean', name: 'Океан', pattern: 'waves',
    dark: P('#0a1724', 'rgba(0,150,255,.18)', 'rgba(0,210,200,.11)', ['#78c8ff', 0.09], ['#1565c0', '#0aa1c4'], '#ffffff', 'rgba(220,240,255,.75)', '#4fc3f7', '#132a3d'),
    light: P('#d9ecfa', 'rgba(0,150,255,.16)', 'rgba(0,210,200,.16)', ['#0a5a9c', 0.09], ['#cfe9ff', '#b9eef7'], '#0b2036', '#3b84b5', '#1e88e5', '#ffffff') },
  { id: 'sunset', name: 'Закат', pattern: 'doodle',
    dark: P('#1a1219', 'rgba(255,120,80,.18)', 'rgba(180,80,200,.14)', ['#ffb48c', 0.08], ['#ff5f3d', '#ff9a52'], '#ffffff', 'rgba(255,240,230,.8)', '#ff8a5c', '#2a1c25'),
    light: P('#fbe6da', 'rgba(255,120,80,.2)', 'rgba(200,100,220,.13)', ['#a04628', 0.08], ['#ffd2bd', '#ffe1b5'], '#3a1a10', '#c26a3c', '#f4511e', '#ffffff') },
  { id: 'forest', name: 'Лес', pattern: 'leaves',
    dark: P('#0e1913', 'rgba(80,200,120,.15)', 'rgba(200,220,90,.08)', ['#8cdca0', 0.08], ['#2e7d32', '#43a047'], '#ffffff', 'rgba(225,255,230,.75)', '#6ccf74', '#17271d'),
    light: P('#e2efe1', 'rgba(80,180,100,.18)', 'rgba(190,210,80,.14)', ['#28643a', 0.09], ['#d2f0cc', '#e4f6c6'], '#102a14', '#4f9a55', '#2e9d4a', '#ffffff') },
  { id: 'lavender', name: 'Лаванда', pattern: 'stars',
    dark: P('#14111f', 'rgba(150,110,255,.2)', 'rgba(255,120,200,.1)', ['#c8b4ff', 0.1], ['#6d4aff', '#a26bfa'], '#ffffff', 'rgba(240,230,255,.78)', '#b39dff', '#221c35'),
    light: P('#ebe5fb', 'rgba(150,110,255,.2)', 'rgba(255,120,200,.12)', ['#5a3caa', 0.1], ['#e0d6ff', '#f2d9ff'], '#21123d', '#7d5cd6', '#7c4dff', '#ffffff') },
  { id: 'rose', name: 'Роза', pattern: 'doodle',
    dark: P('#1b1016', 'rgba(255,90,140,.17)', 'rgba(255,170,120,.09)', ['#ffa0be', 0.08], ['#e2386f', '#f2709c'], '#ffffff', 'rgba(255,235,242,.8)', '#ff7aa2', '#2c1a23'),
    light: P('#fbe3eb', 'rgba(255,90,140,.18)', 'rgba(255,170,120,.14)', ['#aa2850', 0.08], ['#ffd3e1', '#ffe2d2'], '#3d0f1f', '#d0507a', '#e91e63', '#ffffff') },
  { id: 'night', name: 'Звёздная ночь', pattern: 'stars',
    dark: P('#070b19', 'rgba(90,120,255,.18)', 'rgba(255,210,120,.07)', ['#ffffff', 0.16], ['#2b3f8f', '#4461d6'], '#ffffff', 'rgba(220,230,255,.75)', '#8ea4ff', '#131a33'),
    light: P('#dfe4f5', 'rgba(90,120,255,.18)', 'rgba(255,210,120,.14)', ['#28388c', 0.14], ['#d4ddfc', '#e5e0ff'], '#121a3a', '#5566c8', '#3f5bd1', '#ffffff') },
  { id: 'mint', name: 'Мята', pattern: 'dots',
    dark: P('#0b1716', 'rgba(56,239,125,.13)', 'rgba(17,153,142,.16)', ['#78ffc8', 0.07], ['#11998e', '#2fd27a'], '#ffffff', 'rgba(230,255,245,.8)', '#4ee3a3', '#142523'),
    light: P('#dff4ed', 'rgba(56,220,125,.18)', 'rgba(17,153,142,.15)', ['#0a6e5a', 0.09], ['#c6f1df', '#dbf7cf'], '#0b2a22', '#2f9e78', '#11a37f', '#ffffff') },
  { id: 'sand', name: 'Песок', pattern: 'waves',
    dark: P('#19150f', 'rgba(230,170,90,.14)', 'rgba(255,220,150,.07)', ['#f0c88c', 0.07], ['#a8742f', '#c99350'], '#ffffff', 'rgba(255,245,225,.78)', '#e0a96d', '#272017'),
    light: P('#f4ebdd', 'rgba(230,170,90,.2)', 'rgba(255,220,150,.18)', ['#8c6428', 0.09], ['#f2dcb9', '#f8e8c8'], '#2e2210', '#b07a35', '#c47a1f', '#fffdf8') },
  { id: 'neon', name: 'Неон', pattern: 'grid',
    dark: P('#07070f', 'rgba(0,229,255,.18)', 'rgba(255,0,170,.16)', ['#00e5ff', 0.07], ['#00a8f0', '#8a2be2'], '#ffffff', 'rgba(230,240,255,.8)', '#00e5ff', '#151529'),
    light: P('#e7ebff', 'rgba(0,200,255,.18)', 'rgba(255,0,170,.12)', ['#3c28c8', 0.08], ['#caecff', '#e2d2ff'], '#0d0b2e', '#5b4fd6', '#6a3df5', '#ffffff') },
  { id: 'graphite', name: 'Графит', pattern: 'grid',
    dark: P('#111317', 'rgba(255,255,255,.04)', 'rgba(255,255,255,.03)', ['#ffffff', 0.04], ['#3b4049', '#566070'], '#ffffff', 'rgba(255,255,255,.62)', '#b0bec5', '#1d2126'),
    light: P('#e8eaed', 'rgba(0,0,0,.03)', 'rgba(0,0,0,.02)', ['#000000', 0.05], ['#dce1e7', '#e9ecf0'], '#111111', '#6b7580', '#546e7a', '#ffffff') },
];

const byId = id => THEMES.find(t => t.id === id) || THEMES[0];
const mode = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
export const palette = t => t[mode()];
/** Тема чата: своя у пользователя → общая чата → классика */
export const chatThemeId = c => (c && (c.my_theme || c.theme)) || 'classic';
export const themeName = id => byId(id).name;

/* ---------------- узоры ---------------- */

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const svgTile = (w, ht, body) => ([c, a]) => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${ht}' fill='none' stroke='${c}' stroke-opacity='${a}' ` +
    `stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / ${w}px ${ht}px`;
};

const PATTERNS = {
  none: () => null,
  dots: ([c, a]) => `radial-gradient(${rgba(c, a)} 1.2px, transparent 1.5px) 0 0 / 22px 22px`,
  grid: ([c, a]) => `linear-gradient(${rgba(c, a)} 1px, transparent 1px) 0 0 / 34px 34px, ` +
    `linear-gradient(90deg, ${rgba(c, a)} 1px, transparent 1px) 0 0 / 34px 34px`,
  waves: svgTile(160, 44, "<path d='M0 14 Q20 2 40 14 T80 14 T120 14 T160 14'/><path d='M-20 36 Q0 24 20 36 T60 36 T100 36 T140 36 T180 36'/>"),
  doodle: svgTile(200, 200,
    "<path d='M30 40c-7-5-12-10-12-15a6.5 6.5 0 0 1 12-3.5A6.5 6.5 0 0 1 42 25c0 5-5 10-12 15z'/>" +
    "<path d='M150 16l3.6 7.6 8.2 1.1-6 5.7 1.5 8.2-7.3-3.9-7.3 3.9 1.5-8.2-6-5.7 8.2-1.1z'/>" +
    "<path d='M26 112h30a6 6 0 0 1 6 6v13a6 6 0 0 1-6 6H43l-9 7v-7h-8a6 6 0 0 1-6-6v-13a6 6 0 0 1 6-6z'/>" +
    "<path d='M146 150v-24l16-4v22'/><circle cx='142' cy='150' r='4'/><circle cx='158' cy='146' r='4'/>" +
    "<circle cx='100' cy='80' r='11'/><path d='M95 84q5 5 10 0'/><path d='M96 76h.01M104 76h.01'/>" +
    "<circle cx='92' cy='172' r='3.5'/><path d='M178 90v12M172 96h12'/><path d='M66 64l8 3-8 3'/>"),
  stars: svgTile(180, 180,
    "<path d='M40 26l2.5 8 8 2.5-8 2.5-2.5 8-2.5-8-8-2.5 8-2.5z'/><path d='M132 96l1.8 5.7 5.7 1.8-5.7 1.8-1.8 5.7-1.8-5.7-5.7-1.8 5.7-1.8z'/>" +
    "<path d='M72 140l1.5 4.5 4.5 1.5-4.5 1.5-1.5 4.5-1.5-4.5-4.5-1.5 4.5-1.5z'/><circle cx='150' cy='30' r='1.6'/>" +
    "<circle cx='100' cy='60' r='1.2'/><circle cx='20' cy='110' r='1.4'/><circle cx='165' cy='160' r='1.2'/><circle cx='110' cy='170' r='1'/>"),
  leaves: svgTile(200, 200,
    "<path d='M30 70c6-26 30-34 46-32-2 16-12 38-38 44-6 1-9-4-8-12z'/><path d='M34 78c10-12 22-22 38-36'/>" +
    "<g transform='rotate(130 140 130)'><path d='M110 130c6-26 30-34 46-32-2 16-12 38-38 44-6 1-9-4-8-12z'/><path d='M114 138c10-12 22-22 38-36'/></g>" +
    "<circle cx='160' cy='40' r='3'/><circle cx='60' cy='170' r='2.5'/>"),
};

/** Фон чата: два мягких свечения, узор и основной цвет */
export function chatBackground(t, p) {
  const layers = [`radial-gradient(circle at 12% 10%, ${p.glow1}, transparent 45%)`,
    `radial-gradient(circle at 88% 85%, ${p.glow2}, transparent 50%)`, PATTERNS[t.pattern](p.pat), p.base];
  return layers.filter(Boolean).join(', ');
}

const ownGradient = p => `linear-gradient(135deg, ${p.own[0]}, ${p.own[1]})`;
const VARS = ['--own', '--own-bg', '--own-text', '--own-meta', '--in-bubble', '--accent', '--accent-2', '--link', '--chat-bg'];

/** Тема чата → переменные области чата (классика — стили по умолчанию) */
export function applyChatTheme(c) {
  const area = $('#chat-area');
  if (!area) return;
  const t = byId(c ? chatThemeId(c) : 'classic');
  if (!c || t.id === 'classic') {
    VARS.forEach(k => area.style.removeProperty(k));
    delete area.dataset.chatTheme;
    return;
  }
  const p = palette(t);
  const vars = {
    '--own': p.own[1], '--own-bg': ownGradient(p), '--own-text': p.text, '--own-meta': p.meta, '--in-bubble': p.inBubble,
    '--accent': p.accent, '--accent-2': `color-mix(in srgb, ${p.accent} 78%, #000)`, '--link': p.accent, '--chat-bg': chatBackground(t, p),
  };
  for (const [k, v] of Object.entries(vars)) area.style.setProperty(k, v);
  area.dataset.chatTheme = t.id;
}

/* ---------------- выбор темы ---------------- */

export function themeDialog(c) {
  const canAll = c.type !== 'group' || isAdmin(c);
  let picked = chatThemeId(c);
  let scope = c.my_theme || !canAll ? 'me' : 'all';
  const preview = id => applyChatTheme({ ...c, my_theme: id, theme: id });

  const cards = THEMES.map(t => {
    const p = palette(t);
    return h('button.theme-card', { type: 'button', dataset: { id: t.id }, onclick: () => { picked = t.id; mark(); preview(picked); } },
      h('div.theme-prev', { style: { background: chatBackground(t, p) } },
        h('span.tp-in', { style: { background: p.inBubble } }),
        h('span.tp-own', { style: { background: ownGradient(p) } }),
        h('span.tp-dot', { style: { background: p.accent } })),
      h('span.theme-name', t.name));
  });
  const mark = () => cards.forEach(el => el.classList.toggle('active', el.dataset.id === picked));
  mark();

  const scopeBtns = canAll ? [['all', c.type === 'group' ? 'Для всех участников' : 'Для нас обоих'], ['me', 'Только для меня']]
    .map(([id, label]) => h('button', { type: 'button', onclick: () => { scope = id; scopeBtns.forEach(b => b.classList.toggle('active', b.dataset.s === scope)); }, dataset: { s: id } }, label)) : [];
  scopeBtns.forEach(b => b.classList.toggle('active', b.dataset.s === scope));

  const save = async () => {
    try {
      await S.sock.call('chats.theme', { id: c.id, theme: picked === 'classic' ? '' : picked, scope });
      toast(`Тема «${themeName(picked)}»` + (scope === 'all' ? ' — у всех' : ' — у вас'));
      done = true;
      m.close();
    } catch (e) { toast(e.message); }
  };
  let done = false;
  const m = openModal({
    title: 'Оформление чата', cls: 'wide',
    body: h('div.modal-form',
      h('div.theme-grid', cards),
      canAll ? h('div.segmented', scopeBtns) : h('p.muted.small-note', 'Тема будет только у вас. Общую тему группы меняют администраторы.')),
    onClose: () => { if (!done) applyChatTheme(S.chats.get(c.id) || c); },
    actions: [{ label: 'Отмена', onclick: () => m.close() }, { label: 'Сохранить', primary: true, onclick: save }],
  });
}
