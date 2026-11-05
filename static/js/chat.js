// Открытый чат: шапка, вкладки, лента сообщений, поле ввода.
import {
  S, on, emit, putUser, putChat, chatTitle, chatAvatar, activeTab, tabMsgs, isAdmin, userName, chatVoice, prefs,
  shareOrigin, sortedChats, textTabs,
} from './store.js';
import {
  $, h, clear, icon, avatar, fmtTime, fmtDay, fmtLastSeen, richText, isEmojiOnly, describeMessage, toast, showMenu,
  closeMenu, confirmDialog, promptDialog, openModal, onLongPress, copyText, isMobile, plural, fmtShort, debounce,
} from './ui.js';
import { upload } from './api.js';
import { messageContent, sendFilesDialog, recordVoice, recordVideoNote, downloadMedia } from './media.js';
import { renderStage, renderCallBar, startCall } from './voice.js';
import { toggleInfo, openUserProfile, closeInfo, openSafetyCode } from './info.js';
import * as e2e from './crypto.js';
import { openMapScreen, requestsDialog } from './places.js';
import { applyChatTheme } from './themes.js';
import { emojiMessage, playEmoji, burstAt } from './emoji-fx.js';

const GROUP_GAP = 5 * 60;
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉', '🤔', '👎'];
const EMOJI = '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤗 🤭 🤫 🤔 🤐 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖 😺 🙈 🙉 🙊 💋 💌 💘 💝 💖 💗 💓 💞 💕 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💯 💢 💥 💫 💦 💨 💬 💤 👋 🤚 ✋ 🖖 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 👍 👎 ✊ 👊 👏 🙌 👐 🤝 🙏 💪 🧠 👀 🔥 ⭐ 🌟 ✨ ⚡ 🎉 🎊 🎁 🏆 ⚽ 🎮 🎧 🎵 📱 💻 ☕ 🍕 🍔 🍟 🍺 🍷 🌹 🌈 ☀️ 🌙 ❄️ 🐶 🐱 🦊 🐻 🐼 🐸 🦄 🚀 ✅ ❌ ❓ ❗'.split(' ');

const V = {
  tabId: null,
  els: new Map(),        // messageId -> element
  inner: null,
  newBelow: 0,
  reply: null,
  edit: null,
  drafts: new Map(),
  typingSent: 0,
  loadingOlder: false,
  pending: new Map(),    // nonce -> «отправляется…»: сообщение видно сразу, не дожидаясь ответа сервера
};
let nonceSeq = 0;

let area, emptyEl, chatEl, headEl, callBarEl, tabsEl, bodyEl, box, fab, stageEl, composerWrap, barEl, uploadsEl,
  composerRow, input, sendBtn, micBtn, circleBtn, dropEl, keyBannerEl, reqBannerEl, pinBarEl;
const pinCache = new Map();   // закреплённые сообщения, которых нет в загруженной ленте

/** Плашка «Закреплённое сообщение» над лентой вкладки */
async function updatePinBar() {
  const c = curChat(), t = curTab();
  if (!pinBarEl) return;
  if (!c || !t || !t.pinned) { pinBarEl.hidden = true; return; }
  let m = tabMsgs(t.id).list.find(x => x.id === t.pinned) || pinCache.get(t.pinned);
  if (!m) {
    try {
      const res = await S.sock.call('messages.get', { id: t.pinned });
      res.users.forEach(putUser);
      m = await e2e.decryptMessage(res.message);
      pinCache.set(m.id, m);
    } catch (e) { pinBarEl.hidden = true; return; }
  }
  if (curTab() !== t || t.pinned !== m.id) return;
  const canPin = c.type !== 'group' || isAdmin(c);
  clear(pinBarEl,
    icon('pinned'),
    h('div.pin-text', { onclick: () => jumpToMsg(m.id) }, h('b', 'Закреплённое сообщение'), h('span', describeMessage(m) || '…')),
    canPin ? h('button.icon-btn.small', { title: 'Открепить', onclick: () => pinMessage(t.id, null) }, icon('x')) : null);
  pinBarEl.hidden = false;
}

function pinMessage(tabId, id) {
  S.sock.call('messages.pin', { tab: tabId, id }).catch(e => toast(e.message));
}

/** Прокрутить к сообщению, подгрузив историю, если оно выше загруженного */
async function jumpToMsg(id) {
  const st = tabMsgs(V.tabId);
  for (let i = 0; i < 50 && !st.loaded; i++) await new Promise(r => setTimeout(r, 100));
  for (let i = 0; i < 40 && !V.els.get(id) && st.hasMore; i++) await loadOlder();
  jumpTo(id);
}

/** У админа группы с карты ждут заявки — плашка над лентой, пока их не разберут */
function updateReqBanner() {
  const c = curChat();
  if (!reqBannerEl) return;
  const n = c && isAdmin(c) ? c.requests || 0 : 0;
  reqBannerEl.hidden = !n;
  if (!n) return;
  clear(reqBannerEl,
    icon('userPlus'),
    h('span', `${n} ${plural(n, 'заявка', 'заявки', 'заявок')} на вступление`),
    h('button.ghost-btn', { onclick: () => requestsDialog(c) }, 'Посмотреть'));
}

/** Ключ собеседника сменился с прошлого раза — предупреждаем, пока код не сверят */
async function updateKeyBanner() {
  const c = curChat();
  if (!keyBannerEl) return;
  keyBannerEl.hidden = true;
  if (!c || c.type !== 'dm' || !c.peer) return;
  const trust = await e2e.trustOf(c.peer.id);
  if (curChat() !== c || !trust || !trust.changed || trust.verified) return;
  clear(keyBannerEl,
    h('span', `⚠️ Ключ безопасности ${c.peer.name} изменился. Если он не переустанавливал аккаунт, сверьте код — возможно, кто-то подменил ключ.`),
    h('button.ghost-btn', { onclick: () => openSafetyCode(c.peer) }, 'Сверить'));
  keyBannerEl.hidden = false;
}

const curChat = () => (S.current ? S.chats.get(S.current) : null);
const curTab = () => { const c = curChat(); return c ? c.tabs.find(t => t.id === V.tabId) || null : null; };
const dayKey = ts => new Date(ts * 1000).toDateString();
const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 140;
const msgById = id => tabMsgs(V.tabId).list.find(m => m.id === id);

/* ============================================================ init */

export function initChat() {
  area = $('#chat-area');
  const shareEl = h('div.empty-share');
  emptyEl = h('div.chat-empty',
    h('div.chat-empty-card', icon('chat'), h('b', 'Выберите чат'), h('span', 'или создайте группу — у каждой есть текстовые вкладки и голосовые каналы'),
      h('button.ghost-btn.empty-map', { onclick: () => openMapScreen() }, icon('map'), 'Группы на карте'),
      shareEl));
  // ссылка для друзей прямо на стартовом экране — её же печатает окно TabChat
  const renderShare = () => {
    const url = S.server && S.server.public_url;
    clear(shareEl, url ? [
      h('div.empty-share-label', 'Ссылка для друзей — работает из любой сети'),
      h('button.empty-share-link', { title: 'Скопировать', onclick: () => copyText(url, 'Ссылка скопирована') }, h('span', url), icon('copy')),
    ] : null);
  };
  on('server', renderShare);
  renderShare();
  headEl = h('header.chat-head');
  callBarEl = h('div.call-bar-slot');
  tabsEl = h('nav.tabs');
  box = h('div.messages');
  fab = h('button.fab-down', { hidden: true, title: 'Вниз', onclick: () => scrollToBottom(true) }, icon('arrowDown'), h('span.badge', { hidden: true }));
  dropEl = h('div.drop-overlay', { hidden: true }, h('div', icon('attach'), h('b', 'Отпустите, чтобы отправить')));
  keyBannerEl = h('div.key-banner', { hidden: true });
  reqBannerEl = h('div.key-banner.req-banner', { hidden: true });
  pinBarEl = h('div.pin-bar', { hidden: true });
  bodyEl = h('div.chat-body', keyBannerEl, reqBannerEl, box, fab, dropEl);
  stageEl = h('div.voice-stage', { hidden: true });
  barEl = h('div.composer-bar', { hidden: true });
  uploadsEl = h('div.uploads');
  buildComposer();
  composerWrap = h('div.composer-wrap', uploadsEl, barEl, composerRow);
  chatEl = h('div.chat', { hidden: true }, headEl, callBarEl, tabsEl, pinBarEl, bodyEl, stageEl, composerWrap);
  clear(area, emptyEl, chatEl);

  box.addEventListener('scroll', onScroll, { passive: true });
  setupDrop();

  on('chats', onChatsChanged);
  on('message', onMessage);
  on('message_edit', onMessageEdit);
  on('message_delete', onMessageDelete);
  on('reactions', onReactions);
  on('read', onRead);
  on('typing', d => { const c = curChat(); if (c && d.chat === c.id) renderHead(); });
  on('presence', () => renderHead());
  on('user', () => { renderHead(); });
  const refreshVoice = d => {
    const c = curChat();
    if (!c || (d && d.chat !== c.id)) return;
    if (d) { renderTabs(); renderHead(); }
    renderCallBar(callBarEl, c);
    const t = curTab();
    if (t && t.kind === 'voice') renderStage(stageEl, c, t);
  };
  on('voice', refreshVoice);
  on('voice-ui', () => refreshVoice(null));
  on('chat_removed', id => { if (id === S.current) closeChat(); });
  on('key_changed', () => updateKeyBanner());
  on('compose:media', sendMedia);
  on('theme', () => applyChatTheme(curChat()));

  document.addEventListener('visibilitychange', maybeMarkRead);
  window.addEventListener('focus', maybeMarkRead);
}

/* ============================================================ открытие */

export function openChat(chatId, tabId) {
  const c = S.chats.get(chatId);
  if (!c) return;
  saveDraft();
  if (S.current !== chatId) closeInfo();
  S.current = chatId;
  if (tabId) S.lastTab.set(chatId, tabId);
  emit('current');
  $('#app').classList.add('chat-open');
  emptyEl.hidden = true;
  chatEl.hidden = false;
  chatEl.dataset.type = c.type;
  applyChatTheme(c);
  renderHead();
  renderCallBar(callBarEl, c);
  selectTab(activeTab(c).id, true);
  updateKeyBanner();
  updateReqBanner();
  updatePinBar();
}

export async function openDm(userId) {
  try {
    const chat = putChat(await S.sock.call('chats.open_dm', { user: userId }));
    openChat(chat.id);
    emit('chats');
  } catch (e) { toast(e.message); }
}

export function closeChat() {
  saveDraft();
  S.current = null;
  V.tabId = null;
  emit('current');
  $('#app').classList.remove('chat-open');
  chatEl.hidden = true;
  emptyEl.hidden = false;
  applyChatTheme(null);
  closeInfo();
}

/** Сообщение пришло во вкладку, которую человек сейчас видит внизу ленты */
export function isLive(tabId) {
  return !!area && V.tabId === tabId && !chatEl.hidden && !bodyEl.hidden && document.visibilityState === 'visible' && nearBottom();
}

function selectTab(tabId, force) {
  const c = curChat();
  const t = c && c.tabs.find(x => x.id === tabId);
  if (!t || (!force && V.tabId === tabId)) return;
  saveDraft();
  V.tabId = t.id;
  S.lastTab.set(c.id, t.id);
  setTimeout(updatePinBar, 0);
  cancelReplyEdit();
  renderTabs();
  closeMenu();
  if (t.kind === 'voice') {
    bodyEl.hidden = true;
    composerWrap.hidden = true;
    stageEl.hidden = false;
    renderStage(stageEl, c, t);
  } else {
    stageEl.hidden = true;
    bodyEl.hidden = false;
    composerWrap.hidden = false;
    restoreDraft();
    loadTab(t);
    if (!isMobile()) input.focus();
  }
}

function onChatsChanged() {
  const c = curChat();
  if (!c) { if (S.current && !S.chats.has(S.current)) closeChat(); return; }
  chatEl.dataset.type = c.type;
  applyChatTheme(c);
  renderHead();
  updateReqBanner();
  updatePinBar();
  if (V.pendingTab && c.tabs.some(t => t.id === V.pendingTab)) {
    const id = V.pendingTab;
    V.pendingTab = null;
    selectTab(id);
    return;
  }
  renderTabs();
  if (!c.tabs.some(t => t.id === V.tabId)) selectTab(activeTab(c).id, true);
  else updateTicks();
}

/* ============================================================ шапка */

function typingText(c) {
  const now = Date.now();
  const names = [];
  let kind = 'text';
  const tabs = c.type === 'group' ? [V.tabId] : c.tabs.map(t => t.id);
  for (const tid of tabs) {
    for (const [uid, x] of S.typing.get(tid) || []) {
      if (x.until > now && uid !== S.me.id) { names.push(x.name.split(' ')[0]); kind = x.kind; }
    }
  }
  if (!names.length) return null;
  const what = kind === 'voice' ? 'записывает голосовое' : kind === 'video_note' ? 'записывает видео' : 'печатает';
  if (c.type !== 'group') return what + '…';
  if (names.length === 1) return `${names[0]} ${what}…`;
  return `${names.length} ${plural(names.length, 'человек', 'человека', 'человек')} печатают…`;
}

function renderHead() {
  const c = curChat();
  if (!c || !headEl) return;
  let sub;
  const typing = typingText(c);
  if (typing) sub = h('span.accent', typing);
  else if (c.type === 'dm') sub = h('span' + (c.peer && c.peer.online ? '.accent' : ''), fmtLastSeen(c.peer));
  else if (c.type === 'saved') sub = 'заметки для себя';
  else {
    const voice = chatVoice(c).reduce((n, v) => n + v.parts.length, 0);
    sub = h('span', `${c.members} ${plural(c.members, 'участник', 'участника', 'участников')}`, voice ? h('span.green', ` · ${voice} в голосе`) : null);
  }
  clear(headEl,
    h('button.icon-btn.only-mobile', { title: 'Назад', onclick: closeChat }, icon('back')),
    h('div.head-main', { onclick: () => toggleInfo() },
      avatar(chatAvatar(c), { size: 42, online: c.type === 'dm' && c.peer && c.peer.online }),
      h('div.head-text', h('div.head-title', chatTitle(c), c.muted ? icon('bellOff', 'head-muted') : null,
        h('span.e2e-badge', {
          title: c.type === 'dm' ? 'Сквозное шифрование — нажмите, чтобы сверить код безопасности' : 'Сквозное шифрование: сообщения видят только участники',
          onclick: e => { if (c.type === 'dm' && c.peer) { e.stopPropagation(); openSafetyCode(c.peer); } },
        }, icon('lock'))), h('div.head-sub', sub))),
    c.type === 'dm' ? h('button.icon-btn', { title: 'Видеозвонок', onclick: () => startCall(c, { video: true }) }, icon('camera')) : null,
    c.type === 'dm' ? h('button.icon-btn', { title: 'Позвонить', onclick: () => startCall(c) }, icon('phone')) : null,
    h('button.icon-btn', { title: 'Поиск по чату', onclick: () => searchDialog(c) }, icon('search')),
    h('button.icon-btn', { title: 'Информация', onclick: () => toggleInfo() }, icon('info')),
    h('button.icon-btn', { title: 'Ещё', onclick: e => chatMenu(e, c) }, icon('more')));
}

function chatMenu(e, c) {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.right - 220, r.bottom + 4, [
    c.type !== 'saved' ? { icon: c.muted ? 'bell' : 'bellOff', label: c.muted ? 'Включить уведомления' : 'Без звука', onclick: () => S.sock.call('chats.mute', { id: c.id, muted: !c.muted }).catch(err => toast(err.message)) } : null,
    c.type === 'group' && c.invite ? { icon: 'link', label: 'Скопировать приглашение', onclick: () => copyText(`${shareOrigin()}/join/${c.invite}`, 'Ссылка-приглашение скопирована') } : null,
    c.type === 'dm' ? { icon: 'phone', label: 'Позвонить', onclick: () => startCall(c) } : null,
    c.type === 'dm' ? { icon: 'camera', label: 'Видеозвонок', onclick: () => startCall(c, { video: true }) } : null,
    { icon: 'info', label: c.type === 'group' ? 'Информация о группе' : 'Профиль', onclick: () => toggleInfo(true) },
    c.type === 'group' ? { icon: 'door', label: 'Покинуть группу', danger: true, onclick: async () => {
      if (await confirmDialog(`Покинуть группу «${c.title}»?`, { ok: 'Покинуть', danger: true })) S.sock.call('chats.leave', { id: c.id }).catch(err => toast(err.message));
    } } : null,
  ]);
}

/* ============================================================ вкладки */

function renderTabs() {
  const c = curChat();
  if (!c) return;
  const show = c.type === 'group';
  tabsEl.hidden = !show;
  if (!show) return;
  clear(tabsEl);
  for (const t of c.tabs) {
    const parts = t.kind === 'voice' ? S.voice.get(t.id) || [] : [];
    const b = h('button.tab.' + t.kind + (t.id === V.tabId ? '.active' : '') + (parts.length ? '.live' : ''), {
      onclick: () => selectTab(t.id),
      oncontextmenu: e => { e.preventDefault(); tabMenu(e, c, t); },
    }, icon(t.kind === 'voice' ? 'speaker' : 'hash'), h('span', t.name));
    if (t.kind === 'text' && t.unread) b.append(h('span.badge' + (c.muted ? '.muted' : ''), t.unread > 99 ? '99+' : String(t.unread)));
    if (parts.length) {
      const seen = new Set();
      const faces = h('span.tab-faces');
      for (const p of parts) {
        if (seen.has(p.user) || seen.size >= 3) continue;
        seen.add(p.user);
        faces.append(avatar(p.u || { name: '?' }, { size: 18, speakId: p.conn }));
      }
      b.append(faces);
    }
    onLongPress(b, e => tabMenu(e, c, t));
    tabsEl.append(b);
  }
  if (isAdmin(c)) tabsEl.append(h('button.tab.tab-add', { title: 'Новая вкладка', onclick: () => newTabDialog(c) }, icon('plus')));
  const act = tabsEl.querySelector('.tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function tabMenu(e, c, t) {
  if (!isAdmin(c)) return;
  showMenu(e.clientX, e.clientY, [
    { icon: 'edit', label: 'Переименовать', onclick: async () => {
      const name = await promptDialog('Название вкладки', { value: t.name, maxlength: 32 });
      if (name) S.sock.call('tabs.rename', { tab: t.id, name }).catch(err => toast(err.message));
    } },
    { icon: 'trash', label: 'Удалить вкладку', danger: true, onclick: async () => {
      if (await confirmDialog(`Удалить вкладку «${t.name}»${t.kind === 'text' ? ' вместе со всеми сообщениями' : ''}?`, { ok: 'Удалить', danger: true })) {
        S.sock.call('tabs.delete', { tab: t.id }).catch(err => toast(err.message));
      }
    } },
  ]);
}

function newTabDialog(c) {
  let kind = 'text';
  const name = h('input.field', { placeholder: 'Например: Идеи', maxlength: 32 });
  const seg = h('div.segmented',
    h('button.active', { type: 'button', dataset: { k: 'text' } }, icon('hash'), 'Текстовая'),
    h('button', { type: 'button', dataset: { k: 'voice' } }, icon('speaker'), 'Голосовая'));
  seg.querySelectorAll('button').forEach(b => b.onclick = () => {
    kind = b.dataset.k;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    name.placeholder = kind === 'voice' ? 'Например: Созвон' : 'Например: Идеи';
    name.focus();
  });
  const form = h('form.modal-form', { onsubmit: async e => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    try {
      const res = await S.sock.call('tabs.create', { chat: c.id, name: name.value.trim(), kind });
      m.close();
      S.lastTab.set(c.id, res.id);
      // событие с обновлённым чатом могло прийти раньше ответа — тогда переключаемся сразу
      const fresh = curChat();
      if (fresh && fresh.id === c.id && fresh.tabs.some(t => t.id === res.id)) selectTab(res.id);
      else V.pendingTab = res.id;
    } catch (err) { toast(err.message); }
  } }, seg, name);
  const m = openModal({ title: 'Новая вкладка', body: form, actions: [
    { label: 'Отмена', onclick: () => m.close() },
    { label: 'Создать', primary: true, onclick: () => form.requestSubmit() },
  ] });
}

/* ============================================================ лента */

async function loadTab(t) {
  const st = tabMsgs(t.id);
  V.newBelow = 0;
  updateFab();
  const unreadAfter = t.unread ? t.read : null;
  if (!st.loaded) {
    clear(box, h('div.loading', h('div.spinner')));
    if (!st.loading) {
      st.loading = true;
      try {
        const res = await S.sock.call('messages.list', { tab: t.id, limit: 60 });
        res.users.forEach(putUser);
        await Promise.all(res.messages.map(m => e2e.decryptMessage(m)));
        // пока грузили, могли прийти новые сообщения — склеиваем без дублей
        const ids = new Set(res.messages.map(m => m.id));
        st.list = res.messages.concat(st.list.filter(m => !ids.has(m.id) && m.id > (res.messages.length ? res.messages[res.messages.length - 1].id : 0)));
        st.hasMore = res.has_more;
        st.loaded = true;
      } catch (e) {
        st.loading = false;
        if (V.tabId === t.id) clear(box, h('div.loading', h('span.muted', 'Не удалось загрузить сообщения'), h('button.ghost-btn', { onclick: () => loadTab(t) }, 'Повторить')));
        return;
      }
      st.loading = false;
    } else return;
    if (V.tabId !== t.id) return;
  }
  renderList(unreadAfter);
}

function daySep(ts) {
  return h('div.day-sep', { dataset: { day: dayKey(ts) } }, h('span', fmtDay(ts)));
}

function renderList(unreadAfter) {
  const st = tabMsgs(V.tabId);
  V.els.clear();
  const inner = h('div.messages-inner');
  V.inner = inner;
  if (st.hasMore) inner.append(h('div.load-more', h('div.spinner.small')));
  if (!st.list.length) {
    const c = curChat();
    inner.append(h('div.list-placeholder', icon(c.type === 'saved' ? 'bookmark' : 'chat'),
      h('b', c.type === 'saved' ? 'Избранное' : 'Здесь пока пусто'),
      h('span', c.type === 'saved' ? 'Пересылайте сюда заметки, файлы и голосовые — их видите только вы' : 'Напишите первое сообщение, запишите голосовое или кружок')));
  }
  let prevDay = null;
  let unreadEl = null;
  for (const m of st.list) {
    const d = dayKey(m.ts);
    if (d !== prevDay) inner.append(daySep(m.ts));
    prevDay = d;
    if (unreadAfter != null && !unreadEl && m.id > unreadAfter && m.user !== S.me.id && m.kind !== 'system') {
      unreadEl = h('div.unread-sep', h('span', 'Непрочитанные сообщения'));
      inner.append(unreadEl);
    }
    const el = buildMessage(m);
    V.els.set(m.id, el);
    inner.append(el);
  }
  clear(box, inner);
  [...inner.querySelectorAll('.msg-emoji')].slice(-3).forEach(playEmoji);   // свежие смайлики «оживают» при открытии
  applyGrouping();
  if (unreadEl && unreadEl.offsetTop > box.clientHeight / 2) {
    box.scrollTop = unreadEl.offsetTop - 60;
  } else {
    box.scrollTop = box.scrollHeight;
  }
  updateFab();
  maybeMarkRead();
}

function applyGrouping() {
  const list = tabMsgs(V.tabId).list;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const el = V.els.get(m.id);
    if (!el || m.kind === 'system') continue;
    const prev = list[i - 1], next = list[i + 1];
    const first = !prev || prev.kind === 'system' || prev.user !== m.user || m.ts - prev.ts > GROUP_GAP || dayKey(prev.ts) !== dayKey(m.ts);
    const last = !next || next.kind === 'system' || next.user !== m.user || next.ts - m.ts > GROUP_GAP || dayKey(next.ts) !== dayKey(m.ts);
    el.classList.toggle('first', first);
    el.classList.toggle('last', last);
  }
}

/** Убираем лишние разделители дат (после подгрузки старых и удаления) */
function fixSeparators() {
  if (!V.inner) return;
  const seen = new Set();
  const kids = [...V.inner.children];
  kids.forEach((el, i) => {
    if (!el.classList.contains('day-sep')) return;
    const next = kids.slice(i + 1).find(x => !x.classList.contains('unread-sep'));
    if (seen.has(el.dataset.day) || !next || next.classList.contains('day-sep')) el.remove();
    else seen.add(el.dataset.day);
  });
}

function appendMessage(m, fresh = false) {
  const st = tabMsgs(V.tabId);
  const prev = st.list[st.list.indexOf(m) - 1];
  const placeholder = V.inner && V.inner.querySelector('.list-placeholder');
  if (placeholder) placeholder.remove();
  if (!V.inner) return;
  if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) V.inner.append(daySep(m.ts));
  const el = buildMessage(m);
  V.els.set(m.id, el);
  if (fresh) {
    el.classList.add('fresh');
    playEmoji(el);
  }
  V.inner.append(el);
  applyGrouping();
}

async function loadOlder() {
  const st = tabMsgs(V.tabId);
  if (!st.hasMore || V.loadingOlder || !st.list.length) return;
  V.loadingOlder = true;
  const tabId = V.tabId;
  try {
    const res = await S.sock.call('messages.list', { tab: tabId, before: st.list[0].id, limit: 60 });
    res.users.forEach(putUser);
    await Promise.all(res.messages.map(m => e2e.decryptMessage(m)));
    if (V.tabId !== tabId) return;
    st.list = res.messages.concat(st.list);
    st.hasMore = res.has_more;
    const frag = document.createDocumentFragment();
    let prevDay = null;
    for (const m of res.messages) {
      const d = dayKey(m.ts);
      if (d !== prevDay) frag.append(daySep(m.ts));
      prevDay = d;
      const el = buildMessage(m);
      V.els.set(m.id, el);
      frag.append(el);
    }
    const loader = V.inner.querySelector('.load-more');
    const before = box.scrollHeight;
    if (loader) loader.after(frag); else V.inner.prepend(frag);
    if (!st.hasMore && loader) loader.remove();
    fixSeparators();
    applyGrouping();
    box.scrollTop += box.scrollHeight - before;
  } catch (e) { /* попробуем при следующей прокрутке */ }
  finally { V.loadingOlder = false; }
}

function scrollToBottom(smooth) {
  box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  V.newBelow = 0;
  updateFab();
}

let readTimer = null;
function onScroll() {
  if (box.scrollTop < 400) loadOlder();
  if (nearBottom()) V.newBelow = 0;
  updateFab();
  clearTimeout(readTimer);
  readTimer = setTimeout(maybeMarkRead, 150);
}

function updateFab() {
  const far = box.scrollHeight - box.scrollTop - box.clientHeight > 300;
  fab.hidden = !far;
  const badge = fab.querySelector('.badge');
  badge.hidden = !V.newBelow;
  badge.textContent = V.newBelow;
}

function maybeMarkRead() {
  const t = curTab();
  if (!t || t.kind !== 'text' || bodyEl.hidden || chatEl.hidden || document.visibilityState !== 'visible' || !nearBottom()) return;
  const list = tabMsgs(t.id).list;
  const last = list[list.length - 1];
  if (!last) return;
  if (last.id > (t.read || 0) || t.unread) {
    const upto = Math.max(last.id, t.read || 0);
    t.read = upto;
    t.unread = 0;
    S.sock.call('messages.read', { tab: t.id, upto }).catch(() => {});
    emit('chats');
  }
}

/* ============================================================ сообщения */

function replyQuote(r) {
  if (r.deleted) return h('div.msg-reply.deleted', h('div.reply-text', 'Сообщение удалено'));
  const author = S.users.get(r.user);
  return h('div.msg-reply', {
    style: { '--c': author ? author.color : 'var(--accent)' },
    onclick: e => { e.stopPropagation(); jumpTo(r.id); },
  }, h('div.reply-name', author ? author.name : 'Сообщение'), h('div.reply-text', describeMessage(r) || '…'));
}

function jumpTo(id) {
  const el = V.els.get(id);
  if (!el) { toast('Сообщение выше в истории — прокрутите вверх'); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function ticks(m) {
  const t = curTab();
  const read = t && t.others_read >= m.id;
  return h('span.ticks' + (read ? '.read' : ''), icon(read ? 'checks' : 'check'));
}

function metaEl(m, own) {
  const c = curChat();
  // сообщения, отправленные до включения шифрования, честно помечаем открытым замком
  const legacy = !m.enc ? h('span.legacy-lock', { title: 'Отправлено до включения сквозного шифрования' }, '🔓') : null;
  return h('span.msg-meta', legacy, m.edited ? h('span.edited', 'изм.') : null, fmtTime(m.ts), own && c.type !== 'saved' ? ticks(m) : null);
}

/** Сообщение, которое не удалось расшифровать — вместо содержимого */
function e2eStub(m) {
  if (m.e2e === 'nokey') {
    return h('div.msg-text.e2e-stub', { title: 'Ключ этого сообщения ещё не передали — он придёт, когда кто-то из участников будет в сети' },
      '🔒 Ожидание ключа шифрования…');
  }
  if (m.e2e === 'changed') {
    return h('div.msg-text.e2e-stub.bad', { title: 'Сервер выдал для отправителя другой ключ. Сверьте код безопасности в его профиле' },
      '⚠️ Ключ отправителя изменился — сверьте код безопасности');
  }
  return h('div.msg-text.e2e-stub.bad', { title: 'Подпись не сошлась или данные повреждены' }, '⚠️ Не удалось расшифровать сообщение');
}

function reactionsEl(m) {
  const box_ = h('div.reactions');
  for (const r of m.reactions || []) {
    const mine = r.u.includes(S.me.id);
    box_.append(h('button.reaction' + (mine ? '.mine' : ''), {
      title: r.u.map(userName).join(', '),
      onclick: e => { e.stopPropagation(); react(m.id, r.e); },
    }, h('span.r-emoji', r.e), r.u.length > 1 || curChat().type === 'group' ? h('span.r-count', r.u.length) : null));
  }
  return box_;
}

function react(id, emoji) {
  S.sock.call('messages.react', { id, emoji }).catch(e => toast(e.message));
}

function buildMessage(m) {
  if (m.kind === 'system') return h('div.msg-system', { dataset: { id: m.id } }, h('span', m.text));
  const c = curChat();
  const own = m.user === S.me.id;
  const group = c.type === 'group';
  const author = S.users.get(m.user) || { name: 'Удалённый аккаунт', color: '#8a8a8a' };
  const locked = m.enc && m.e2e !== 'ok';
  const emojiOnly = !locked && m.kind === 'text' && !m.reply && isEmojiOnly(m.text);
  const bare = !locked && (m.kind === 'video_note' || emojiOnly);

  const el = h('div.msg' + (own ? '.own' : '.other') + (bare ? '.bare' : '') + (group ? '.in-group' : ''), { dataset: { id: m.id } });
  if (group && !own) el.append(h('div.msg-avatar', { onclick: () => openUserProfile(m.user) }, avatar(author, { size: 34 })));

  const bubble = h('div.bubble.kind-' + (locked ? 'text' : m.kind));
  if (group && !own && !bare) {
    bubble.append(h('div.msg-name', { style: { color: author.color }, onclick: () => openUserProfile(m.user) }, author.name));
  }
  if (m.reply) bubble.append(replyQuote(m.reply));
  if (m.fw && !locked) bubble.append(h('div.msg-fw', icon('forward'), 'Переслано от ', h('b', m.fw.n)));

  if (locked) {
    bubble.append(e2eStub(m), metaEl(m, own));
  } else if (m.kind === 'poll') {
    bubble.append(pollEl(m), metaEl(m, own));
  } else if (m.kind === 'text') {
    if (emojiOnly) bubble.append(emojiMessage(m.text), metaEl(m, own));
    else bubble.append(richText(h('div.msg-text'), m.text, { onMention: mentionClick }), metaEl(m, own));
  } else {
    bubble.append(messageContent(m, { own }));
    if (m.text) bubble.append(richText(h('div.msg-text.caption'), m.text, { onMention: mentionClick }));
    bubble.append(metaEl(m, own));
  }
  const col = h('div.msg-col', bubble, m.reactions && m.reactions.length ? reactionsEl(m) : null);
  el.append(col);

  el.addEventListener('contextmenu', e => { e.preventDefault(); msgMenu(e, m.id); });
  el.addEventListener('dblclick', e => {
    if (e.target.closest('button, a, video, audio, .voice-msg, .vnote')) return;
    const msg = msgById(m.id);
    if (msg) setReply(msg);
  });
  onLongPress(el, e => msgMenu(e, m.id));
  return el;
}

/* ============================================================ опросы */

function pollEl(m) {
  const p = m.poll || { q: 'Опрос', o: [] };
  const votes = m.votes || {};
  const voters = new Set(Object.values(votes).flat());
  const total = voters.size;
  return h('div.poll',
    h('div.poll-q', icon('poll'), h('b', p.q)),
    p.o.map((text, i) => {
      const who = votes[i] || [];
      const pct = total ? Math.round(who.length * 100 / total) : 0;
      return h('button.poll-opt' + (who.includes(S.me.id) ? '.mine' : ''), {
        style: { '--pct': pct + '%' },
        onclick: e => { e.stopPropagation(); S.sock.call('polls.vote', { id: m.id, option: i }).catch(err => toast(err.message)); },
      }, h('span.poll-text', text), h('span.poll-n', total ? pct + '%' : ''));
    }),
    h('div.poll-total', total ? `${total} ${plural(total, 'голос', 'голоса', 'голосов')} · нажмите ещё раз, чтобы отменить` : 'Пока никто не голосовал'));
}

function pollDialog() {
  const c = curChat(), tabId = V.tabId;
  const q = h('input.field', { placeholder: 'Вопрос', maxlength: 200 });
  const opts = h('div.poll-edit');
  const addOpt = () => {
    if (opts.children.length < 10) opts.append(h('input.field', { placeholder: 'Вариант ' + (opts.children.length + 1), maxlength: 100 }));
  };
  addOpt();
  addOpt();
  const md = openModal({
    title: 'Новый опрос',
    body: h('div.modal-form', q, opts, h('button.link-btn', { type: 'button', onclick: addOpt }, '+ Добавить вариант'),
      h('p.muted.small-note', 'Вопрос и варианты зашифрованы. Сервер видит только, кто выбрал какой по счёту вариант.')),
    actions: [{ label: 'Отмена', onclick: () => md.close() }, { label: 'Создать', primary: true, onclick: send }],
  });
  async function send() {
    const o = [...opts.querySelectorAll('input')].map(x => x.value.trim()).filter(Boolean);
    if (!q.value.trim() || o.length < 2) { toast('Нужны вопрос и хотя бы два варианта'); return; }
    md.close();
    try {
      await encryptedCall(c, tabId, 'poll', { t: '', poll: { q: q.value.trim(), o } },
        (epoch, enc) => S.sock.call('messages.send', { tab: tabId, kind: 'poll', epoch, enc }));
    } catch (e) { toast(e.message); }
  }
}

/* ============================================================ пересылка */

function forwardDialog(m) {
  const search = h('input.field', { type: 'search', placeholder: 'Кому переслать', autocomplete: 'off' });
  const list = h('div.pick-list.forward-list');
  const md = openModal({ title: 'Переслать', body: h('div.modal-form', search, list) });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    clear(list, sortedChats().filter(c => chatTitle(c).toLowerCase().includes(q)).map(c =>
      h('button.forward-row', { type: 'button', onclick: () => go(c) }, avatar(chatAvatar(c), { size: 38 }), h('span', chatTitle(c)))));
  };
  search.addEventListener('input', render);
  render();
  async function go(c) {
    md.close();
    try {
      await forwardTo(m, c);
      toast(`Переслано в «${chatTitle(c)}»`);
    } catch (e) { toast(e.message); }
  }
}

/** Пересылка — это новое сообщение, зашифрованное ключом другого чата; файл перешифровывается своим ключом */
async function forwardTo(m, c) {
  const tabs = textTabs(c);
  const tab = tabs.find(t => t.id === S.lastTab.get(c.id)) || tabs[0];
  const fw = m.fw || { n: (S.users.get(m.user) || {}).name || 'Пользователь' };
  if (!m.media) {
    return encryptedCall(c, tab.id, 'text', { t: m.text, fw },
      (epoch, enc) => S.sock.call('messages.send', { tab: tab.id, kind: 'text', epoch, enc }));
  }
  const blob = await (await fetch(await e2e.mediaSrc(m))).blob();
  const sealed = await e2e.encryptFile(blob);
  const up = await upload(sealed.blob, 'file', S.token);
  const f = { ...e2e.fileToPayload(m.meta), k: sealed.key, iv: sealed.iv };
  return encryptedCall(c, tab.id, m.kind, { t: m.text || '', f, fw },
    (epoch, enc) => S.sock.call('messages.send', { tab: tab.id, kind: m.kind, media: up.id, epoch, enc }));
}

/* ============================================================ поиск */

/** Переписка зашифрована, сервер искать не может — история подгружается и ищется прямо на устройстве */
function searchDialog(c) {
  const input = h('input.field', { type: 'search', placeholder: 'Слово или фраза', autocomplete: 'off' });
  const status = h('div.muted.small-note', 'Загружаем историю чата…');
  const list = h('div.search-list');
  const md = openModal({ title: 'Поиск по чату', body: h('div.modal-form', input, status, list), cls: 'wide' });
  const all = new Map();
  let loaded = false;

  async function loadAll() {
    for (const t of textTabs(c)) {
      const msgs = [];
      let before = null;
      for (let page = 0; page < 30; page++) {          // до 3000 сообщений на вкладку
        const res = await S.sock.call('messages.list', { tab: t.id, limit: 100, before });
        res.users.forEach(putUser);
        await Promise.all(res.messages.map(x => e2e.decryptMessage(x)));
        msgs.unshift(...res.messages);
        if (!res.has_more || !res.messages.length) break;
        before = res.messages[0].id;
      }
      all.set(t.id, msgs);
    }
    loaded = true;
    status.textContent = 'Введите хотя бы две буквы';
    run();
  }

  function run() {
    if (!loaded) return;
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { clear(list); return; }
    const found = [];
    for (const t of textTabs(c)) {
      for (const m of all.get(t.id) || []) {
        const txt = [m.text, m.poll && m.poll.q, ...(m.poll ? m.poll.o : []), m.meta && m.meta.name].filter(Boolean).join(' · ');
        if (m.kind !== 'system' && txt.toLowerCase().includes(q)) found.push({ m, t, txt });
      }
    }
    found.sort((a, b) => b.m.ts - a.m.ts);
    status.textContent = found.length ? `Найдено: ${found.length}` : 'Ничего не нашлось';
    clear(list, found.slice(0, 100).map(({ m, t, txt }) => {
      const u = S.users.get(m.user) || { name: 'Удалённый аккаунт', color: '#888' };
      return h('button.search-row', { type: 'button', onclick: () => { md.close(); openFound(m); } },
        avatar(u, { size: 34 }),
        h('div.search-text',
          h('div.search-head', h('b', u.name), h('span', (textTabs(c).length > 1 ? '#' + t.name + ' · ' : '') + fmtShort(m.ts))),
          h('div.search-snippet', snippet(txt, q))));
    }));
  }

  input.addEventListener('input', debounce(run, 150));
  loadAll().catch(e => { status.textContent = e.message; });
}

function snippet(txt, q) {
  const i = txt.toLowerCase().indexOf(q);
  const s = Math.max(0, i - 30);
  return [s ? '…' : '', txt.slice(s, i), h('mark', txt.slice(i, i + q.length)), txt.slice(i + q.length, i + q.length + 80)];
}

async function openFound(m) {
  if (V.tabId !== m.tab) selectTab(m.tab);
  await jumpToMsg(m.id);
}

async function mentionClick(username) {
  try {
    const u = putUser(await S.sock.call('users.get', { username }));
    openUserProfile(u.id);
  } catch (e) { toast('Пользователь @' + username + ' не найден'); }
}

function msgMenu(e, id) {
  const m = msgById(id);
  if (!m || m.kind === 'system') return;
  const c = curChat();
  const own = m.user === S.me.id;
  const row = h('div.reaction-row', REACTIONS.map(r => h('button', { onclick: ev => {
    ev.stopPropagation();
    const rect = ev.currentTarget.getBoundingClientRect();
    closeMenu();
    react(m.id, r);
    burstAt(rect, r, undefined, 8);
  } }, r)));
  showMenu(e.clientX, e.clientY, [
    row,
    { icon: 'reply', label: 'Ответить', onclick: () => setReply(m) },
    (!m.enc || m.e2e === 'ok') && m.kind !== 'poll' ? { icon: 'forward', label: 'Переслать', onclick: () => forwardDialog(m) } : null,
    c.type !== 'group' || isAdmin(c) ? (curTab() && curTab().pinned === m.id
      ? { icon: 'pinned', label: 'Открепить', onclick: () => pinMessage(m.tab, null) }
      : { icon: 'pinned', label: 'Закрепить', onclick: () => pinMessage(m.tab, m.id) }) : null,
    m.text ? { icon: 'copy', label: 'Копировать текст', onclick: () => copyText(m.text) } : null,
    own && ['text', 'image', 'file'].includes(m.kind) ? { icon: 'edit', label: 'Изменить', onclick: () => setEdit(m) } : null,
    m.media && (!m.enc || m.e2e === 'ok') ? { icon: 'download', label: 'Скачать', onclick: () => downloadMedia(m) } : null,
    own || isAdmin(c) ? { icon: 'trash', label: 'Удалить', danger: true, onclick: async () => {
      if (await confirmDialog('Удалить сообщение у всех участников?', { ok: 'Удалить', danger: true, title: 'Удаление' })) {
        S.sock.call('messages.delete', { id: m.id }).catch(err => toast(err.message));
      }
    } } : null,
  ], 'msg-menu');
}

/* ============================================================ события ленты */

function onMessage({ message: m, live, nonce }) {
  const replacesDraft = nonce && V.pending.has(nonce);   // своё «отправляется…» уже появилось с анимацией
  if (nonce) dropPending(nonce);
  if (m.tab !== V.tabId || !V.inner) return;
  const own = m.user === S.me.id;
  const wasBottom = live || nearBottom();
  appendMessage(m, !replacesDraft);
  if (own || wasBottom) scrollToBottom(false);
  else if (m.kind !== 'system') { V.newBelow++; updateFab(); }
  maybeMarkRead();
}

function onMessageEdit(m) {
  const el = V.els.get(m.id);
  if (!el) return;
  const fresh = buildMessage(m);
  fresh.className = el.className;
  el.replaceWith(fresh);
  V.els.set(m.id, fresh);
}

function onMessageDelete(d) {
  const el = V.els.get(d.id);
  if (!el) return;
  el.remove();
  V.els.delete(d.id);
  fixSeparators();
  applyGrouping();
  if (V.edit && V.edit.id === d.id) cancelReplyEdit();
  if (V.reply && V.reply.id === d.id) cancelReplyEdit();
}

function onReactions(d) {
  const el = V.els.get(d.id);
  const m = msgById(d.id);
  if (!el || !m) return;
  const col = el.querySelector('.msg-col');
  const old = col.querySelector('.reactions');
  if (old) old.remove();
  if (m.reactions.length) col.append(reactionsEl(m));
}

function onRead(d) {
  if (d.tab === V.tabId && d.user !== S.me.id) updateTicks();
}

function updateTicks() {
  const t = curTab();
  if (!t || t.kind !== 'text') return;
  for (const [id, el] of V.els) {
    const tk = el.querySelector('.ticks');
    if (!tk || tk.classList.contains('read') || t.others_read < id) continue;
    tk.classList.add('read');
    clear(tk, icon('checks'));
  }
}

/* ============================================================ поле ввода */

function buildComposer() {
  input = h('textarea.composer-input', { rows: 1, placeholder: 'Сообщение', maxlength: 4000 });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => {
    if (fileInput.files.length) sendFilesDialog([...fileInput.files], sendMedia);
    fileInput.value = '';
  } });
  sendBtn = h('button.send-btn', { title: 'Отправить', onclick: send }, icon('send'));
  micBtn = h('button.icon-btn.rec-btn', { title: 'Голосовое сообщение', onclick: startVoice }, icon('mic'));
  circleBtn = h('button.icon-btn.rec-btn', { title: 'Видеосообщение (кружок)', onclick: startCircle }, icon('camera'));
  const emojiBtn = h('button.icon-btn', { title: 'Эмодзи', onclick: e => emojiPicker(e) }, icon('smile'));
  composerRow = h('div.composer',
    h('button.icon-btn', { title: 'Прикрепить', onclick: e => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.top - 100, [
        { icon: 'attach', label: 'Фото или файл', onclick: () => fileInput.click() },
        { icon: 'poll', label: 'Опрос', onclick: pollDialog },
      ]);
    } }, icon('attach')), fileInput,
    h('div.input-wrap', input, emojiBtn),
    micBtn, circleBtn, sendBtn);

  input.addEventListener('input', () => {
    autosize();
    if (input.value.trim() && !V.edit && Date.now() - V.typingSent > 3000) {
      V.typingSent = Date.now();
      S.sock.fire('typing', { tab: V.tabId, kind: 'text' });
    }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isMobile() && prefs.get('enterSend', true)) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && (V.reply || V.edit)) { e.stopPropagation(); cancelReplyEdit(); }
    else if (e.key === 'ArrowUp' && !input.value) {
      const mine = [...tabMsgs(V.tabId).list].reverse().find(m => m.user === S.me.id && m.kind === 'text');
      if (mine) { e.preventDefault(); setEdit(mine); }
    }
  });
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); sendFilesDialog(files, sendMedia); }
  });
  autosize();
}

function autosize() {
  input.style.height = '';
  if (input.value) input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  const has = !!input.value.trim() || !!V.edit;
  sendBtn.hidden = !has;
  micBtn.hidden = has;
  circleBtn.hidden = has;
}

function saveDraft() {
  if (V.tabId == null || !input) return;
  if (V.edit) return;
  if (input.value.trim()) V.drafts.set(V.tabId, input.value);
  else V.drafts.delete(V.tabId);
}

function restoreDraft() {
  input.value = V.drafts.get(V.tabId) || '';
  autosize();
}

/** Зашифровать и отправить. Если ключ чата успел смениться (кто-то вышел) — перешифровать и повторить. */
async function encryptedCall(chat, tabId, kind, payload, call) {
  for (let attempt = 0; ; attempt++) {
    const { epoch, enc } = await e2e.encryptPayload(chat, tabId, kind, payload);
    try {
      return await call(epoch, enc);
    } catch (err) {
      if (!/^e2e:/.test(err.message) || attempt >= 2) throw err;
      await e2e.chatState(chat.id, true);
    }
  }
}

async function send() {
  const text = input.value.trim();
  const tabId = V.tabId;
  const chat = curChat();
  if (V.edit) {
    const m = V.edit;
    if (!text && m.kind === 'text') return;
    cancelReplyEdit();
    if (text === m.text) return;
    const payload = { t: text };
    if (m.kind !== 'text') payload.f = e2e.fileToPayload(m.meta);
    encryptedCall(chat, m.tab, m.kind, payload, (epoch, enc) => S.sock.call('messages.edit', { id: m.id, epoch, enc }))
      .catch(e => toast(e.message));
    return;
  }
  if (!text) return;
  const reply = V.reply ? V.reply.id : null;
  input.value = '';
  V.drafts.delete(tabId);
  cancelReplyEdit();
  autosize();
  input.focus();
  const nonce = Date.now().toString(36) + '.' + (++nonceSeq);
  showPending(text, nonce);
  try {
    await encryptedCall(chat, tabId, 'text', { t: text },
      (epoch, enc) => S.sock.call('messages.send', { tab: tabId, kind: 'text', epoch, enc, reply_to: reply, nonce }));
  } catch (e) {
    toast(e.message);
    if (!input.value) { input.value = text; autosize(); }
  } finally {
    dropPending(nonce);  // обычно его уже заменило настоящее сообщение — оно приходит раньше ответа
  }
}

/** Сообщение появляется сразу с часиками, а не через полсекунды, когда сервер (через туннель) его вернёт. */
function showPending(text, nonce) {
  if (!V.inner) return;
  const m = { id: 'pending', user: S.me.id, kind: 'text', text, ts: Date.now() / 1000, enc: true, e2e: 'ok', reply: null };
  const el = buildMessage(m);
  el.classList.add('pending', 'last', 'fresh');
  playEmoji(el);
  const prev = V.inner.lastElementChild;
  const joins = prev && prev.classList.contains('own');
  el.classList.toggle('first', !joins);
  if (joins) prev.classList.remove('last');
  const ticksEl = el.querySelector('.ticks');
  if (ticksEl) ticksEl.replaceWith(h('span.ticks', { title: 'Отправляется…' }, icon('clock')));
  const placeholder = V.inner.querySelector('.list-placeholder');
  if (placeholder) placeholder.remove();
  V.inner.append(el);
  V.pending.set(nonce, el);
  scrollToBottom(false);
}

function dropPending(nonce) {
  const el = V.pending.get(nonce);
  if (!el) return;
  V.pending.delete(nonce);
  el.remove();
  if (V.inner) applyGrouping();
}

function showBar(kind, m) {
  const author = S.users.get(m.user);
  clear(barEl,
    icon(kind === 'edit' ? 'edit' : 'reply', 'accent'),
    h('div.bar-text', { onclick: () => jumpTo(m.id) },
      h('div.bar-title', kind === 'edit' ? 'Редактирование' : 'Ответ ' + (author ? author.name : '')),
      h('div.bar-sub', describeMessage(m) || '…')),
    h('button.icon-btn', { title: 'Отмена', onclick: () => cancelReplyEdit() }, icon('x')));
  barEl.hidden = false;
}

function setReply(m) {
  if (V.edit) { input.value = ''; V.edit = null; }
  V.reply = m;
  showBar('reply', m);
  autosize();
  input.focus();
}

function setEdit(m) {
  saveDraft();
  V.reply = null;
  V.edit = m;
  input.value = m.text;
  showBar('edit', m);
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function cancelReplyEdit() {
  const wasEdit = !!V.edit;
  V.reply = null;
  V.edit = null;
  if (barEl) barEl.hidden = true;
  if (wasEdit) restoreDraft();
  else if (input) autosize();
}

function emojiPicker(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const grid = h('div.emoji-grid', EMOJI.map(em => h('button', { onclick: ev => {
    ev.stopPropagation();
    const s = input.selectionStart ?? input.value.length, en = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, s) + em + input.value.slice(en);
    input.setSelectionRange(s + em.length, s + em.length);
    input.focus();
    autosize();
  } }, em)));
  const menu = showMenu(r.right - 320, r.top - 300, [grid], 'emoji-menu');
  const mr = menu.getBoundingClientRect();
  menu.style.top = Math.max(8, r.top - mr.height - 8) + 'px';
}

/* ============================================================ медиа */

/** Зашифровать файл, загрузить шифротекст и отправить сообщением. Прогресс — над полем ввода. */
export async function sendMedia({ blob, name, kind, meta = {}, text = '' }) {
  const tabId = V.tabId;
  const chat = curChat();
  const reply = V.reply ? V.reply.id : null;
  if (reply) cancelReplyEdit();
  const label = { voice: 'Голосовое сообщение', video_note: 'Видеосообщение', image: name || 'Фото', file: name || 'Файл' }[kind];
  const pct = h('span.upload-pct', 'шифрование…');
  const fill = h('div.upload-fill');
  const row = h('div.upload-item', icon(kind === 'voice' ? 'mic' : kind === 'video_note' ? 'camera' : kind === 'image' ? 'image' : 'file'),
    h('span.upload-name', label), pct, h('div.upload-track', fill));
  uploadsEl.append(row);
  try {
    // на сервер уходит только шифротекст; ключ файла, имя, длительность и волна — внутри сообщения
    const box = await e2e.encryptFile(blob);
    const up = await upload(box.blob, 'blob', S.token, p => { pct.textContent = Math.round(p * 100) + '%'; fill.style.width = p * 100 + '%'; });
    const payload = {
      t: text,
      f: { k: box.key, iv: box.iv, mime: blob.type || 'application/octet-stream', name: name || 'file', size: blob.size,
           w: meta.width, h: meta.height, d: meta.duration, wf: meta.waveform },
    };
    await encryptedCall(chat, tabId, kind, payload,
      (epoch, enc) => S.sock.call('messages.send', { tab: tabId, kind, media: up.id, epoch, enc, reply_to: reply }));
  } catch (e) {
    toast(e.message);
  } finally {
    row.remove();
  }
}

function startVoice() {
  recordVoice({
    mount: composerWrap,
    hide: composerRow,
    onTyping: () => S.sock.fire('typing', { tab: V.tabId, kind: 'voice' }),
    onSend: (blob, meta) => sendMedia({ blob, name: 'voice.' + extOf(blob.type), kind: 'voice', meta }),
  });
}

function startCircle() {
  recordVideoNote({
    onTyping: () => S.sock.fire('typing', { tab: V.tabId, kind: 'video_note' }),
    onSend: (blob, meta) => sendMedia({ blob, name: 'video.' + extOf(blob.type), kind: 'video_note', meta }),
  });
}

const extOf = mime => (mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm');

function setupDrop() {
  let depth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  bodyEl.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; dropEl.hidden = false; });
  bodyEl.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  bodyEl.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dropEl.hidden = true; });
  bodyEl.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    dropEl.hidden = true;
    const files = [...e.dataTransfer.files];
    if (files.length) sendFilesDialog(files, sendMedia);
  });
}
