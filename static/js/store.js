// Состояние клиента и шина событий между модулями.

export const S = {
  sock: null,          // Socket
  token: null,
  me: null,            // публичный профиль текущего пользователя
  conn: null,          // id моего подключения (для голоса)
  users: new Map(),    // id -> user
  chats: new Map(),    // id -> chat
  current: null,       // id открытого чата
  lastTab: new Map(),  // chatId -> tabId, последняя открытая вкладка
  msgs: new Map(),     // tabId -> {list, hasMore, loaded, loading}
  voice: new Map(),    // tabId -> [participants]
  typing: new Map(),   // tabId -> Map(userId -> {name, kind, until})
  status: 'connecting',
  server: { public_url: null, lan_urls: [], ice: [] },  // адрес в интернете (туннель), адреса в сети, TURN
  app: null,           // приложение TabChat.exe: {server, servers, launcher, …}; в браузере — null
};

/** Адрес, который можно отправить другу: интернет → сеть → текущий */
export function shareOrigin() {
  if (S.server.public_url) return S.server.public_url;
  // в приложении страница открыта с 127.0.0.1 — делимся адресом самого сервера
  const appUrl = S.app && S.app.server ? S.app.server.url : null;
  const host = appUrl ? new URL(appUrl).hostname : location.hostname;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (local && S.server.lan_urls && S.server.lan_urls.length) return S.server.lan_urls[0];
  return appUrl || location.origin;
}

/* ---------------- шина ---------------- */

const listeners = new Map();

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

export function emit(name, data) {
  for (const fn of listeners.get(name) || []) {
    try { fn(data); } catch (e) { console.error(e); }
  }
}

/* ---------------- пользователи ---------------- */

export function putUser(u) {
  if (!u || !u.id) return null;
  const prev = S.users.get(u.id);
  const merged = prev ? Object.assign(prev, u) : { ...u };
  S.users.set(u.id, merged);
  if (S.me && u.id === S.me.id) Object.assign(S.me, u);
  return merged;
}

export const userById = id => S.users.get(id) || null;
export const userName = id => (S.users.get(id) || {}).name || 'Пользователь';

/* ---------------- чаты ---------------- */

export function putChat(c) {
  if (c.peer) c.peer = putUser(c.peer);
  if (c.last_author) putUser(c.last_author);
  S.chats.set(c.id, c);
  return c;
}

export function chatTitle(c) {
  if (!c) return '';
  if (c.type === 'saved') return 'Избранное';
  if (c.type === 'dm') return c.peer ? c.peer.name : 'Удалённый аккаунт';
  return c.title;
}

/** То, что рисуем в аватаре чата */
export function chatAvatar(c) {
  if (c.type === 'saved') return { title: 'Избранное', color: '#4ea4f6', saved: true };
  if (c.type === 'dm') return c.peer || { name: '?', color: '#888' };
  return { title: c.title, color: c.color, avatar: c.avatar, emoji: c.emoji };
}

export const textTabs = c => c.tabs.filter(t => t.kind === 'text');
export const voiceTabs = c => c.tabs.filter(t => t.kind === 'voice');
export const chatUnread = c => textTabs(c).reduce((n, t) => n + (t.unread || 0), 0);
export const isAdmin = c => c && c.type === 'group' && (c.role === 'owner' || c.role === 'admin');

export function findTab(tabId) {
  for (const c of S.chats.values()) {
    const t = c.tabs.find(x => x.id === tabId);
    if (t) return { chat: c, tab: t };
  }
  return { chat: null, tab: null };
}

export function activeTab(c) {
  if (!c) return null;
  const id = S.lastTab.get(c.id);
  return c.tabs.find(t => t.id === id) || textTabs(c)[0] || c.tabs[0];
}

export const chatTime = c => (c.last ? c.last.ts : c.created);

export function sortedChats() {
  return [...S.chats.values()]
    .filter(c => !(c.type === 'dm' && !c.last && c.id !== S.current))
    .sort((a, b) => chatTime(b) - chatTime(a));
}

/** Участники голосовых вкладок чата: [{tab, parts}] */
export function chatVoice(c) {
  return voiceTabs(c).map(t => ({ tab: t, parts: S.voice.get(t.id) || [] })).filter(x => x.parts.length);
}

/* ---------------- сообщения ---------------- */

export function tabMsgs(tabId) {
  if (!S.msgs.has(tabId)) S.msgs.set(tabId, { list: [], hasMore: true, loaded: false, loading: false });
  return S.msgs.get(tabId);
}

/* ---------------- настройки ---------------- */

export const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem('tc.pref.' + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('tc.pref.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
};
