// Точка входа: вход в аккаунт, подключение, разбор событий сервера, ключи шифрования.
import { S, on, emit, putUser, putChat, findTab, prefs, chatTitle } from './store.js';
import { accounts, Socket, http } from './api.js';
import { showAuth } from './auth.js';
import { $, h, clear, toast, openModal, avatar, describeMessage, plural, closeTopModal } from './ui.js';
import { applyTheme, applyAccent } from './theme.js';
import { sounds } from './sounds.js';
import { initSidebar } from './sidebar.js';
import { initChat, openChat, openDm, isLive, closeChat } from './chat.js';
import { initInfo, closeInfo } from './info.js';
import { closeMapScreen } from './places.js';
import {
  initVoice, onSignal, onCall, onCallDeclined, onCallCancel, onKicked, resetAfterReconnect, startCall,
} from './voice.js';
import * as e2e from './crypto.js';
import { loadAppInfo, keepAlive, connectScreen } from './connect.js';

applyTheme(prefs.get('theme', 'dark'));
applyAccent(prefs.get('accent', null));

const inviteCode = (location.pathname.match(/^\/join\/([A-Za-z0-9_-]+)/) || [])[1] || null;

async function boot() {
  // приложение TabChat.exe: сначала — к какому серверу подключаться
  S.app = await loadAppInfo();
  if (S.app) {
    keepAlive();
    if (!S.app.server) { connectScreen(S.app); return; }
  }
  const acc = accounts.active();
  if (acc && e2e.supported()) startSession(acc.token, acc.user);
  else showAuth({ onDone: signedIn, saved: accounts.list() });
}

function signedIn(token, user) {
  accounts.save(token, user);
  accounts.setActive(user.id);
  location.reload();
}

function addAccount() {
  if (S.sock) S.sock.close();
  showAuth({ onDone: signedIn, onBack: () => location.reload(), saved: accounts.list() });
}

async function logout() {
  const me = S.me;
  try { await http('/api/logout', {}, S.token); } catch (e) { /* всё равно выходим локально */ }
  if (S.sock) S.sock.close();
  if (me) {
    accounts.remove(me.id);
    await e2e.forgetIdentity(me.id);   // ключи переписки с этого устройства тоже убираем
  }
  const next = accounts.list()[0];
  if (next) accounts.setActive(next.user.id);
  location.reload();
}

/* ---------------- оболочка ---------------- */

function renderShell() {
  clear($('#root'),
    h('div#app.app',
      h('aside#sidebar.sidebar'),
      h('main#chat-area.chat-area'),
      h('aside#info-panel.info-panel', { hidden: true })),
    h('div#audio-sink', { hidden: true }));
  initSidebar();
  initChat();
  initInfo();
  initVoice();
}

// события обрабатываем строго по очереди: расшифровка асинхронная, порядок сообщений важен
let eventQueue = Promise.resolve();
const queueEvent = (ev, d) => {
  eventQueue = eventQueue.then(() => handleEvent(ev, d)).catch(e => console.error('событие', ev, e));
};

function startSession(token, user) {
  S.token = token;
  S.me = putUser({ ...user, online: true });
  renderShell();
  // ключи этого устройства — сразу из браузера, без сервера
  const stored = e2e.loadIdentity(user.id).then(id => { if (id) e2e.setIdentity(id); return id; });
  let first = true;
  S.sock = new Socket(token, {
    onEvent: queueEvent,
    onStatus: st => { S.status = st; emit('status'); },
    onAuthFail: () => {
      toast('Сеанс завершён — войдите снова');
      accounts.remove(user.id);
      setTimeout(() => location.reload(), 1200);
    },
    onReady: async res => {
      S.conn = res.conn;
      if (!first) resetAfterReconnect();
      await sync();
      await stored;
      await ensureIdentity();
      decryptPreviews();
      if (first && inviteCode) handleInvite(inviteCode);
      first = false;
    },
  });
}

/** Сохраняем уже расшифрованное превью, если сервер прислал то же сообщение */
function storeChat(c) {
  const prev = S.chats.get(c.id);
  if (prev && prev.last && c.last && prev.last.id === c.last.id && prev.last.e2e === 'ok' && prev.last.edited === c.last.edited) {
    c.last = prev.last;
  }
  putChat(c);
  if (c.last && c.last.enc && c.last.e2e !== 'ok' && e2e.identity()) {
    e2e.decryptMessage(c.last).then(() => emit('chats')).catch(() => {});
  }
  return c;
}

async function sync() {
  let data;
  try { data = await S.sock.call('sync'); } catch (e) { toast(e.message); return; }
  S.conn = data.conn;
  S.me = putUser(data.me);
  if (data.server) { S.server = data.server; emit('server'); }
  accounts.updateUser(data.me);
  const keepCurrent = S.current;
  const old = new Map(S.chats);
  S.chats.clear();
  for (const c of data.chats) {
    const prev = old.get(c.id);
    if (prev && prev.last && c.last && prev.last.id === c.last.id && prev.last.e2e === 'ok') c.last = prev.last;
    putChat(c);
  }
  S.voice.clear();
  for (const [tab, parts] of Object.entries(data.voice || {})) {
    parts.forEach(p => p.u && putUser(p.u));
    S.voice.set(Number(tab), parts);
  }
  // после переподключения могли пропустить сообщения — перезагрузим ленты
  S.msgs.clear();
  emit('chats');
  if (keepCurrent && S.chats.has(keepCurrent)) openChat(keepCurrent);
}

async function decryptPreviews() {
  await Promise.all([...S.chats.values()].map(c => (c.last && c.last.enc ? e2e.decryptMessage(c.last).catch(() => {}) : null)));
  emit('chats');
  // заодно передадим ключи тем, кто их ждёт (например, новичкам, пока мы были офлайн)
  for (const c of S.chats.values()) e2e.heal(c.id).catch(() => {});
}

/* ---------------- ключи шифрования на этом устройстве ---------------- */

let unlocking = null;

async function ensureIdentity() {
  if (e2e.identity()) return;
  const stored = await e2e.loadIdentity(S.me.id);
  if (stored) { e2e.setIdentity(stored); return; }
  if (!unlocking) unlocking = unlockDialog().finally(() => { unlocking = null; });
  await unlocking;
}

/** Ключей на устройстве нет: открываем копию с сервера паролем (или впервые включаем шифрование) */
async function unlockDialog() {
  let info;
  try { info = await S.sock.call('keys.info'); } catch (e) { toast(e.message); return; }
  const legacy = info.kdf === 'legacy' || !info.has_keys;
  return new Promise(resolve => {
    const pw = h('input.field', { type: 'password', placeholder: 'Пароль от аккаунта', autocomplete: 'current-password' });
    const err = h('div.form-error', { hidden: true });
    const btn = h('button.primary-btn', { type: 'submit' }, legacy ? 'Включить шифрование' : 'Расшифровать');
    const form = h('form.modal-form', {
      onsubmit: async e => {
        e.preventDefault();
        err.hidden = true;
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = 'Секунду…';
        try {
          let id;
          if (legacy) {
            const b = await e2e.newAccountBundle(pw.value);
            await S.sock.call('keys.upgrade', { password: pw.value, auth: b.auth, salt: b.salt, iters: b.iters, keys: b.keys });
            id = b.id;
          } else {
            const { backupKey } = await e2e.deriveFromPassword(pw.value, info.salt, info.iters);
            try { id = await e2e.openIdentity(info.backup, backupKey); } catch (ex) { throw new Error('Неверный пароль'); }
          }
          await e2e.saveIdentity(S.me.id, id);
          e2e.setIdentity(id);
          m.close();
          toast(legacy ? 'Сквозное шифрование включено' : 'Переписка расшифрована');
          resolve();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          btn.disabled = false;
          btn.textContent = label;
        }
      },
    },
    h('div.e2e-intro', h('div.e2e-lock', '🔒'),
      h('p.modal-text', legacy
        ? 'Включаем сквозное шифрование: сообщения, файлы и звонки будут видны только участникам чатов — даже сервер их не прочитает. Введите пароль от аккаунта, на сервер он больше уходить не будет.'
        : 'Переписка зашифрована. Чтобы читать её на этом устройстве, введите пароль от аккаунта — ключи расшифруются прямо в браузере.')),
    pw, err,
    h('div.modal-actions',
      h('button.ghost-btn', { type: 'button', onclick: () => emit('auth:logout') }, 'Выйти'),
      btn));
    const m = openModal({ title: 'Сквозное шифрование', body: form, dismissable: false });
  });
}

/* ---------------- приглашения ---------------- */

async function handleInvite(code) {
  history.replaceState(null, '', '/');
  let info;
  try { info = await S.sock.call('chats.invite_info', { code }); } catch (e) { toast(e.message); return; }
  if (info.joined) { openChat(info.id); return; }
  const m = openModal({
    cls: 'profile-modal',
    body: h('div.profile-card',
      avatar({ title: info.title, color: info.color, avatar: info.avatar }, { size: 96 }),
      h('div.profile-name', info.title),
      h('div.profile-status', `${info.members} ${plural(info.members, 'участник', 'участника', 'участников')}`),
      info.about ? h('div.info-about', info.about) : null,
      h('div.profile-actions',
        h('button.ghost-btn', { onclick: () => m.close() }, 'Отмена'),
        h('button.primary-btn', { onclick: async () => {
          try {
            const chat = storeChat(await S.sock.call('chats.join', { code }));
            m.close();
            emit('chats');
            openChat(chat.id);
          } catch (e) { toast(e.message); }
        } }, 'Вступить в группу'))),
  });
}

/* ---------------- уведомления ---------------- */

function notify(m, chat) {
  if (m.user === S.me.id || m.kind === 'system' || chat.muted) return;
  if (isLive(m.tab)) return;
  if (prefs.get('sound', true)) sounds.message();
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted' || !prefs.get('notify', true)) return;
  const author = S.users.get(m.user);
  const title = chat.type === 'group' ? `${author ? author.name : ''} · ${chatTitle(chat)}` : chatTitle(chat);
  try {
    const n = new Notification(title, { body: describeMessage(m), tag: 'chat-' + chat.id, silent: true });
    n.onclick = () => { window.focus(); openChat(chat.id, m.tab); n.close(); };
  } catch (e) { /* ignore */ }
}

/* ---------------- события сервера ---------------- */

async function ensureChat(id) {
  if (S.chats.has(id)) return S.chats.get(id);
  try {
    const c = storeChat(await S.sock.call('chats.get', { id }));
    emit('chats');
    return c;
  } catch (e) { return null; }
}

function updateMsg(tabId, id, fn) {
  const st = S.msgs.get(tabId);
  if (!st) return null;
  const m = st.list.find(x => x.id === id);
  if (m) fn(m);
  return m;
}

/** Пришли ключи чата — расшифровываем то, что раньше не получилось */
async function redecryptChat(chatId) {
  await e2e.chatState(chatId, true);
  const chat = S.chats.get(chatId);
  if (!chat) return;
  for (const t of chat.tabs) {
    const st = S.msgs.get(t.id);
    if (!st) continue;
    for (const m of st.list) {
      if (!m.enc || m.e2e === 'ok') continue;
      m.e2e = null;
      await e2e.decryptMessage(m);
      if (m.e2e === 'ok') emit('message_edit', m);
    }
  }
  if (chat.last && chat.last.enc && chat.last.e2e !== 'ok') {
    chat.last.e2e = null;
    await e2e.decryptMessage(chat.last);
    emit('chats');
  }
}

async function handleEvent(ev, d) {
  switch (ev) {
    case 'message': {
      const m = d.message;
      putUser(d.author);
      await e2e.decryptMessage(m);
      const known = S.chats.has(m.chat);
      const chat = await ensureChat(m.chat);
      if (!chat) return;
      const live = isLive(m.tab);
      const st = S.msgs.get(m.tab);
      if (st && st.loaded && !st.list.some(x => x.id === m.id)) st.list.push(m);
      if (known) {
        chat.last = m;
        chat.last_author = d.author;
        const tab = chat.tabs.find(t => t.id === m.tab);
        if (tab && m.user !== S.me.id && m.kind !== 'system' && !live) tab.unread = (tab.unread || 0) + 1;
      }
      const typing = S.typing.get(m.tab);
      if (typing) typing.delete(m.user);
      emit('message', { message: m, live, nonce: d.nonce });
      emit('chats');
      notify(m, chat);
      break;
    }
    case 'message_edit': {
      const m = d.message;
      await e2e.decryptMessage(m);
      const stored = updateMsg(m.tab, m.id, x => Object.assign(x, m));
      const chat = S.chats.get(m.chat);
      if (chat && chat.last && chat.last.id === m.id) { chat.last = m; emit('chats'); }
      emit('message_edit', stored || m);
      break;
    }
    case 'message_delete': {
      const st = S.msgs.get(d.tab);
      if (st) st.list = st.list.filter(x => x.id !== d.id);
      const chat = S.chats.get(d.chat);
      if (d.last) await e2e.decryptMessage(d.last);
      if (chat) { chat.last = d.last; if (d.last_author) putUser(d.last_author); }
      // ответы на удалённое сообщение
      if (st) st.list.forEach(x => { if (x.reply && x.reply.id === d.id) x.reply = { id: d.id, deleted: true }; });
      emit('message_delete', d);
      emit('chats');
      break;
    }
    case 'reactions':
      updateMsg(d.tab, d.id, x => { x.reactions = d.reactions; });
      emit('reactions', d);
      break;
    case 'read': {
      const { tab } = findTab(d.tab);
      if (!tab) return;
      if (d.user === S.me.id) {
        tab.read = Math.max(tab.read || 0, d.upto);
        if (d.unread != null) tab.unread = d.unread;
      } else {
        tab.others_read = Math.max(tab.others_read || 0, d.upto);
      }
      emit('read', d);
      emit('chats');
      break;
    }
    case 'typing': {
      if (!S.typing.has(d.tab)) S.typing.set(d.tab, new Map());
      S.typing.get(d.tab).set(d.user, { name: d.name, kind: d.kind, until: Date.now() + 4500 });
      emit('typing', d);
      setTimeout(() => emit('typing', d), 4600);
      break;
    }
    case 'chat': {
      const prev = S.chats.get(d.chat.id);
      storeChat(d.chat);
      emit('chats');
      if (!prev && d.chat.type === 'group' && S.welcome !== d.chat.id) toast(`Вас добавили в группу «${d.chat.title}»`);
      break;
    }
    case 'poll_votes': {
      const stored = updateMsg(d.tab, d.id, x => { x.votes = d.votes; });
      if (stored) emit('message_edit', stored);
      break;
    }
    case 'join_request': {
      // админу: кто-то с карты просится в группу
      toast(`${d.user.name} хочет вступить в «${d.title}»`, 5000);
      emit('join_request', d);
      break;
    }
    case 'join_result': {
      if (d.accepted) {
        S.welcome = d.chat;
        toast(`Заявку приняли — вы в группе «${d.title}»`, 5000);
      } else toast(`Заявку в «${d.title}» отклонили`, 5000);
      emit('map:refresh');
      break;
    }
    case 'chat_removed': {
      const c = S.chats.get(d.chat);
      S.chats.delete(d.chat);
      e2e.forgetChat(d.chat);
      if (c) c.tabs.forEach(t => S.msgs.delete(t.id));
      emit('chat_removed', d.chat);
      emit('chats');
      break;
    }
    case 'keys':                 // нам передали ключ чата
      await redecryptChat(d.chat);
      break;
    case 'keys_needed':          // кто-то в чате ждёт ключ — передадим, если он у нас есть
      if (e2e.identity()) e2e.heal(d.chat).catch(() => {});
      break;
    case 'presence':
      putUser({ id: d.user, online: d.online, last_seen: d.last_seen });
      emit('presence', d.user);
      break;
    case 'user':
      putUser(d.user);
      if (d.user.id === S.me.id) accounts.updateUser(d.user);
      emit('user', d.user.id);
      break;
    case 'voice':
      S.voice.set(d.tab, d.parts);
      emit('voice', d);
      break;
    case 'speaking':
      emit('speaking', d);
      break;
    case 'signal':
      onSignal(d);
      break;
    case 'call':
      onCall(d);
      break;
    case 'call_declined':
      onCallDeclined(d);
      break;
    case 'call_cancel':
      onCallCancel(d);
      break;
    case 'voice_kicked':
      onKicked(d);
      break;
    case 'server': {
      const was = S.server.public_url;
      S.server = d;
      emit('server');
      if (d.public_url && d.public_url !== was) toast('Чат доступен из интернета: ' + d.public_url, 5000);
      break;
    }
    default:
      break;
  }
}

/* ---------------- связи между модулями ---------------- */

const warnedKeys = new Set();
on('key_changed', async uid => {
  const t = await e2e.trustOf(uid);
  if (!t || !t.pending || warnedKeys.has(uid)) return;
  warnedKeys.add(uid);
  const u = S.users.get(uid);
  toast(`⚠️ Сервер выдал новый ключ для ${u ? u.name : 'собеседника'}. Пока вы не сверите код безопасности в профиле, ` +
    'ключи чатов ему не передаются, а его новые сообщения не принимаются.', 9000);
});
on('auth:add', addAccount);
on('auth:logout', logout);
on('open-chat', id => openChat(id));
on('open-dm', id => openDm(id));
on('chat:put', c => { storeChat(c); emit('chats'); });
on('start-call', id => { const c = S.chats.get(id); if (c) startCall(c); });
on('call-user', async uid => {
  await openDm(uid);
  const c = S.chats.get(S.current);
  if (c && c.type === 'dm') startCall(c);
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* с самоподписанным сертификатом не регистрируется — это нормально */ });
}

/* ---------------- кнопка «Назад» на телефоне ----------------
   Пока открыт чат, карта, панель или окно, в истории лежит одна лишняя запись. «Назад» снимает её —
   и мы закрываем верхний слой, а не уходим с сайта (на Android раньше закрывалось всё приложение). */

let backArmed = false;
const layerOpen = () => !!(document.querySelector('.modal, .map-screen, .lightbox') ||
  ($('#app') && ($('#app').classList.contains('info-open') || $('#app').classList.contains('chat-open'))));

function armBack() {
  if (!backArmed && layerOpen()) {
    history.pushState({ tcLayer: true }, '');
    backArmed = true;
  }
}

function closeTopLayer() {
  const lightbox = document.querySelector('.lightbox');
  if (lightbox) { lightbox.click(); return true; }
  if (document.querySelector('.modal')) return closeTopModal();
  if (document.querySelector('.map-screen')) { closeMapScreen(); return true; }
  if ($('#app') && $('#app').classList.contains('info-open')) { closeInfo(); return true; }
  if (S.current) { closeChat(); return true; }
  return false;
}

window.addEventListener('popstate', () => {
  if (!backArmed) return;
  backArmed = false;
  closeTopLayer();
  setTimeout(armBack, 250);          // ещё что-то открыто — снова ловим следующее «Назад»
});
// слои открываются по нажатиям — после каждого проверяем, не пора ли поставить «ловушку»
document.addEventListener('click', () => setTimeout(armBack, 0), true);
document.addEventListener('keyup', () => setTimeout(armBack, 0), true);

boot();
