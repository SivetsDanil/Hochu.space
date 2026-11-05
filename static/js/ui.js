// Общие UI-утилиты: создание DOM, иконки, аватары, форматирование, модалки, меню, тосты.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** h('div.a.b', {onclick, title}, child, 'text', [more]) */
export function h(sel, props, ...kids) {
  let [tag, ...cls] = sel.split('.');
  let id = null;
  if (tag.includes('#')) [tag, id] = tag.split('#');
  const el = document.createElement(tag || 'div');
  if (id) el.id = id;
  if (cls.length) el.className = cls.join(' ');
  if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (val == null) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, val);
          else el.style[prop] = val;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else if (['value', 'textContent', 'htmlFor', 'type', 'src', 'href', 'placeholder', 'title'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  appendKids(el, kids);
  return el;
}

function appendKids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : String(k));
  }
}

export function clear(el, ...kids) {
  el.textContent = '';
  appendKids(el, kids);
  return el;
}

/* ---------------- иконки ---------------- */

const P = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  send: '<path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5 2.2"/><path d="M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/>',
  circle: '<circle cx="12" cy="12" r="9"/><path d="M10 9.2v5.6a.5.5 0 0 0 .8.4l4-2.8a.5.5 0 0 0 0-.8l-4-2.8a.5.5 0 0 0-.8.4z" fill="currentColor" stroke="none"/>',
  camera: '<path d="M15 10l5-3v10l-5-3"/><rect x="3" y="6" width="12" height="12" rx="2"/>',
  switchCam: '<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><path d="M9 13a3 3 0 0 1 5.2-2M15 13a3 3 0 0 1-5.2 2"/><path d="M14.5 9.5v1.7h-1.7M9.5 16.5v-1.7h1.7"/>',
  attach: '<path d="M21 11.5 12.4 20a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.6"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  hangup: '<path d="M12 9c-1.6 0-3.2.3-4.6.8v3.1c0 .4-.2.7-.6.9-1 .5-1.9 1.1-2.6 1.8-.2.2-.4.3-.7.3s-.5-.1-.7-.3L.3 13.1A1 1 0 0 1 0 12.4c0-.3.1-.5.3-.7C3.3 8.9 7.4 7 12 7s8.7 1.9 11.7 4.7c.2.2.3.4.3.7s-.1.5-.3.7l-2.5 2.5c-.2.2-.4.3-.7.3s-.5-.1-.7-.3c-.8-.7-1.7-1.3-2.6-1.8a1 1 0 0 1-.6-.9V9.8C15.2 9.3 13.6 9 12 9z" fill="currentColor" stroke="none"/>',
  head: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
  headOff: '<path d="M3 18v-6a9 9 0 0 1 15.4-6.4M21 12v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3zM3 3l18 18"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  minus: '<path d="M5 12h14"/>',
  forward: '<path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/>',
  poll: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
  pinned: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v6"/>',
  pin: '<path d="M12 21.5s-7-6.3-7-11.6a7 7 0 0 1 14 0c0 5.3-7 11.6-7 11.6z"/><circle cx="12" cy="9.8" r="2.6"/>',
  map: '<path d="M9 4 3 6.5V20l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  locate: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  checks: '<path d="m2 12.5 4.5 4.5L16 7.5"/><path d="m11.5 16 1 1L22 7.5"/>',
  reply: '<path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  bellOff: '<path d="M13.7 21a2 2 0 0 1-3.4 0M18.6 13A17.9 17.9 0 0 1 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.3-5M3 3l18 18"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01" stroke-width="2.4"/>',
  arrowDown: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  crown: '<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5z"/>',
  door: '<path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5M3 12h11M10 8l4 4-4 4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  devices: '<rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M6 18h6M9 14v4"/><rect x="17" y="8" width="5" height="12" rx="1"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16" cy="10" r="1.2" fill="currentColor"/><path d="M12 21a2 2 0 0 1 0-4h2a3 3 0 0 0 3-3"/>',
  hash: '<path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18"/>',
  pencilSquare: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M17.5 2.5a2.1 2.1 0 0 1 3 3L12 14l-4 1 1-4z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  cameraOff: '<path d="M15 10l5-3v10l-1.5-.9"/><path d="M11 6h2a2 2 0 0 1 2 2v2M15 15v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2"/><path d="M3 3l18 18"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M12 13V7M9 10l3-3 3 3"/>',
  screenOff: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M9 7l6 6M15 7l-6 6"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
};

export function icon(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return t.content.firstChild;
}

/* ---------------- аватары ---------------- */

export function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => [...w][0]).join('').toUpperCase() || '?';
}

export const mediaUrl = id => `/media/${id}`;

/** entity: {name|title, color, avatar, id?}; opts: {size, online, speakId} */
export function avatar(entity, opts = {}) {
  const name = entity.name || entity.title || '?';
  const el = h('div.avatar', { style: { '--c': entity.color || '#65aadd' } });
  if (opts.size) el.style.setProperty('--size', opts.size + 'px');
  if (entity.saved) el.append(icon('bookmark'));
  else if (entity.avatar) el.append(h('img', { src: mediaUrl(entity.avatar), alt: '', loading: 'lazy', draggable: false }));
  else if (entity.emoji) el.append(h('span.avatar-emoji', entity.emoji));
  else el.append(initials(name));
  if (opts.online) el.append(h('span.online-dot'));
  if (opts.speakId) el.dataset.speak = opts.speakId;
  return el;
}

/* ---------------- форматирование ---------------- */

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();

export const fmtTime = ts => new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function fmtDay(ts) {
  const d = new Date(ts * 1000), now = new Date(), y = new Date();
  y.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'Сегодня';
  if (sameDay(d, y)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** Время для списка чатов: сегодня — часы, неделя — день недели, иначе дата */
export function fmtShort(ts) {
  const d = new Date(ts * 1000), now = new Date();
  if (sameDay(d, now)) return fmtTime(ts);
  if (now - d < 6 * 864e5) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
}

export function fmtLastSeen(user) {
  if (!user) return '';
  if (user.online) return 'в сети';
  if (!user.last_seen) return 'был(а) давно';
  const diff = Date.now() / 1000 - user.last_seen;
  if (diff < 60) return 'был(а) только что';
  if (diff < 3600) { const m = Math.floor(diff / 60); return `был(а) ${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`; }
  const d = new Date(user.last_seen * 1000), now = new Date(), y = new Date();
  y.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return `был(а) сегодня в ${fmtTime(user.last_seen)}`;
  if (sameDay(d, y)) return `был(а) вчера в ${fmtTime(user.last_seen)}`;
  return `был(а) ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace('.0', '') + ' КБ';
  if (bytes < 1024 ** 3) return (bytes / 1024 / 1024).toFixed(1).replace('.0', '') + ' МБ';
  return (bytes / 1024 ** 3).toFixed(2) + ' ГБ';
}

/* ---------------- текст с разметкой ---------------- */

const TOKEN_RE = /(```[\s\S]+?```)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|(@[A-Za-z][A-Za-z0-9_]{2,31})/g;

/** Безопасная разметка в стиле Telegram: **жирный**, __курсив__, ~~зачёркнутый~~, `код`, ```блок```, ссылки, @упоминания */
export function richText(el, text, { onMention } = {}) {
  let last = 0, m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    if (m.index > last) el.append(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) el.append(h('pre', t.slice(3, -3).replace(/^\n/, '')));
    else if (m[2]) el.append(h('code', t.slice(1, -1)));
    else if (m[3]) el.append(h('b', t.slice(2, -2)));
    else if (m[4]) el.append(h('i', t.slice(2, -2)));
    else if (m[5]) el.append(h('s', t.slice(2, -2)));
    else if (m[6]) el.append(h('a', { href: t, target: '_blank', rel: 'noopener noreferrer' }, t));
    else if (m[7]) el.append(h('a.mention', { href: '#', onclick: e => { e.preventDefault(); onMention && onMention(t.slice(1)); } }, t));
    last = m.index + t.length;
  }
  if (last < text.length) el.append(text.slice(last));
  return el;
}

/** Убирает разметку — для превью в списке чатов */
export const plainText = text => text.replace(/```|\*\*|__|~~|`/g, '').replace(/\s+/g, ' ').trim();

/** Короткое описание сообщения: для списка чатов, ответов и уведомлений */
export function describeMessage(m) {
  if (!m) return '';
  if (m.enc && m.e2e !== 'ok') {
    return m.e2e === 'bad' ? '⚠️ Не удалось расшифровать' : m.e2e === 'changed' ? '⚠️ Ключ отправителя изменился'
      : m.e2e === 'nokey' ? '🔒 Ожидание ключа' : '🔒 Зашифрованное сообщение';
  }
  const caption = m.text ? plainText(m.text) : '';
  switch (m.kind) {
    case 'voice': return '🎤 Голосовое сообщение';
    case 'video_note': return '⭕ Видеосообщение';
    case 'image': return '🖼 ' + (caption || 'Фото');
    case 'file': return '📎 ' + (caption || (m.meta && m.meta.name) || 'Файл');
    case 'poll': return '📊 ' + ((m.poll && m.poll.q) || 'Опрос');
    default: return caption;
  }
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;
export const isEmojiOnly = text => text.length <= 32 && EMOJI_ONLY.test(text.trim());

/* ---------------- тосты ---------------- */

export function toast(text, ms = 3200) {
  let box = $('#toasts');
  if (!box) { box = h('div.toasts', { id: 'toasts' }); document.body.append(box); }
  const el = h('div.toast', text);
  box.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
}

/* ---------------- модальные окна ---------------- */

const modalStack = [];

/** openModal({title, body, cls, onClose, actions:[{label, primary, danger, onclick}]}) → {el, close} */
export function openModal({ title, body, cls = '', onClose, actions, dismissable = true }) {
  const card = h('div.modal-card' + (cls ? '.' + cls.split(' ').join('.') : ''));
  const wrap = h('div.modal', card);
  const close = () => {
    const i = modalStack.indexOf(api);
    if (i < 0) return;
    modalStack.splice(i, 1);
    wrap.classList.add('out');
    setTimeout(() => wrap.remove(), 160);
    onClose && onClose();
  };
  const api = { el: card, close, dismissable };
  if (title) card.append(h('div.modal-head', h('h3', title), dismissable ? h('button.icon-btn', { onclick: close, title: 'Закрыть' }, icon('x')) : null));
  if (body) card.append(body);
  if (actions && actions.length) {
    card.append(h('div.modal-actions', actions.map(a =>
      h('button' + (a.primary ? '.primary-btn' : a.danger ? '.danger-btn' : '.ghost-btn'), { type: a.submit ? 'submit' : 'button', onclick: a.onclick }, a.label))));
  }
  wrap.addEventListener('mousedown', e => { if (e.target === wrap && api.dismissable) close(); });
  document.body.append(wrap);
  modalStack.push(api);
  const focusable = card.querySelector('input:not([type=file]), textarea');
  if (focusable && matchMedia('(pointer: fine)').matches) setTimeout(() => focusable.focus(), 30);
  return api;
}

export const closeTopModal = () => {
  const top = modalStack[modalStack.length - 1];
  if (top && top.dismissable) { top.close(); return true; }
  return false;
};

export function confirmDialog(text, { ok = 'OK', danger = false, title = 'Подтверждение' } = {}) {
  return new Promise(resolve => {
    let done = false;
    const m = openModal({
      title, body: h('p.modal-text', text), onClose: () => !done && resolve(false),
      actions: [
        { label: 'Отмена', onclick: () => m.close() },
        { label: ok, primary: !danger, danger, onclick: () => { done = true; resolve(true); m.close(); } },
      ],
    });
  });
}

export function promptDialog(title, { value = '', placeholder = '', maxlength = 64, ok = 'Сохранить', multiline = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const input = h(multiline ? 'textarea.field' : 'input.field', { value, placeholder, maxlength, rows: multiline ? 3 : undefined });
    const form = h('form.modal-form', { onsubmit: e => { e.preventDefault(); done = true; resolve(input.value.trim()); m.close(); } }, input);
    const m = openModal({
      title, body: form, onClose: () => !done && resolve(null),
      actions: [{ label: 'Отмена', onclick: () => m.close() }, { label: ok, primary: true, onclick: () => form.requestSubmit() }],
    });
  });
}

/* ---------------- контекстное меню ---------------- */

let openMenu = null;

export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}

/** items: [{icon, label, onclick, danger} | Node | null] */
export function showMenu(x, y, items, cls = '') {
  closeMenu();
  const menu = h('div.menu' + (cls ? '.' + cls : ''));
  for (const it of items) {
    if (!it) continue;
    if (it instanceof Node) { menu.append(it); continue; }
    menu.append(h('button.menu-item' + (it.danger ? '.danger' : ''), {
      onclick: e => { e.stopPropagation(); closeMenu(); it.onclick(); },
    }, it.icon ? icon(it.icon) : null, h('span', it.label)));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, x), innerWidth - r.width - 8);
  const top = y + r.height > innerHeight - 8 ? Math.max(8, y - r.height) : y;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  openMenu = menu;
  return menu;
}

document.addEventListener('mousedown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (openMenu) closeMenu(); else closeTopModal(); }
});

/** Долгое нажатие на телефоне = правый клик */
export function onLongPress(el, fn) {
  let timer = null, sx = 0, sy = 0;
  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    timer = setTimeout(() => { timer = null; fn({ clientX: sx, clientY: sy, preventDefault() {} }); }, 480);
  }, { passive: true });
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchmove', e => { const t = e.touches[0]; if (Math.hypot(t.clientX - sx, t.clientY - sy) > 10) cancel(); }, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
}

export async function copyText(text, note = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
    toast(note);
  } catch (e) {
    window.prompt('Скопируйте:', text);
  }
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export const isMobile = () => matchMedia('(max-width: 760px)').matches;
