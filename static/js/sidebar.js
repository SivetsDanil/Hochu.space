// Левая колонка: список чатов, поиск, меню, создание группы.
import { S, on, emit, sortedChats, chatTitle, chatAvatar, chatUnread, chatVoice, putUser, prefs } from './store.js';
import { accounts } from './api.js';
import { accountRow } from './auth.js';
import {
  $, h, clear, icon, avatar, fmtShort, describeMessage, toast, openModal, showMenu, debounce, copyText,
} from './ui.js';
import { openChat, openDm } from './chat.js';
import { openSettings } from './settings.js';
import { applyTheme } from './theme.js';
import { forgetIdentity } from './crypto.js';
import { openMapScreen } from './places.js';

let listEl, searchInput, resultsEl, statusEl;
let query = '';

export function initSidebar() {
  const side = $('#sidebar');
  searchInput = h('input.search-input', {
    placeholder: 'Поиск чатов и людей', type: 'search', autocomplete: 'off', spellcheck: false,
    oninput: () => { query = searchInput.value.trim(); renderSearch(); },
    onkeydown: e => { if (e.key === 'Escape') { searchInput.value = ''; query = ''; renderSearch(); searchInput.blur(); } },
  });
  statusEl = h('div.conn-status', { hidden: true });
  listEl = h('div.chat-list');
  resultsEl = h('div.search-results', { hidden: true });

  clear(side,
    h('div.side-head',
      h('button.icon-btn', { title: 'Меню', onclick: openDrawer }, icon('menu')),
      h('label.search-box', icon('search'), searchInput),
      h('button.icon-btn', { title: 'Карта групп', onclick: () => openMapScreen() }, icon('map'))),
    statusEl,
    h('div.side-scroll', listEl, resultsEl),
    h('button.fab', { title: 'Новый чат', onclick: e => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left - 150, r.top - 8, [
        { icon: 'link', label: 'Пригласить друзей', onclick: inviteDialog },
        { icon: 'users', label: 'Новая группа', onclick: newGroupDialog },
        { icon: 'map', label: 'Группы на карте', onclick: () => openMapScreen() },
        { icon: 'user', label: 'Написать человеку', onclick: () => { searchInput.focus(); toast('Найдите человека по имени или @username'); } },
        { icon: 'bookmark', label: 'Избранное', onclick: openSaved },
      ]);
    } }, icon('pencilSquare')),
    h('div#voice-panel.voice-panel-slot', { hidden: true }),
  );

  on('chats', renderList);
  on('current', renderList);
  on('presence', renderList);
  on('user', renderList);
  on('typing', renderList);
  on('voice', renderList);
  on('status', renderStatus);
  renderList();
}

function renderStatus() {
  const text = { connecting: 'Подключение…', offline: 'Нет связи с сервером. Переподключаемся…' }[S.status];
  statusEl.hidden = !text;
  statusEl.textContent = text || '';
}

function openSaved() {
  const saved = [...S.chats.values()].find(c => c.type === 'saved');
  if (saved) openChat(saved.id);
}

/* ---------------- список чатов ---------------- */

function typingIn(chat) {
  for (const t of chat.tabs) {
    const m = S.typing.get(t.id);
    if (!m) continue;
    const now = Date.now();
    for (const [uid, x] of m) {
      if (x.until > now && uid !== (S.me && S.me.id)) return { ...x, uid };
    }
  }
  return null;
}

function chatItem(c) {
  const title = chatTitle(c);
  const av = chatAvatar(c);
  const unread = chatUnread(c);
  const voice = chatVoice(c);
  const typing = typingIn(c);
  const last = c.last;
  const own = last && S.me && last.user === S.me.id;

  let preview;
  if (typing) {
    const what = typing.kind === 'voice' ? 'записывает голосовое' : typing.kind === 'video_note' ? 'записывает видео' : 'печатает';
    preview = h('span.ci-typing', c.type === 'group' ? `${typing.name.split(' ')[0]} ${what}…` : `${what}…`);
  } else if (last) {
    const author = last.kind === 'system' ? '' : own ? 'Вы: ' : c.type === 'group' ? ((S.users.get(last.user) || {}).name || '').split(' ')[0] + ': ' : '';
    preview = h('span', author ? h('span.ci-author', author) : null, describeMessage(last));
  } else {
    preview = h('span.ci-empty', c.type === 'saved' ? 'Сохраняйте сюда заметки и файлы' : c.type === 'group' ? 'Группа создана' : 'Нет сообщений');
  }

  const textTab = c.tabs.find(t => t.kind === 'text' && last && t.id === last.tab);
  const read = own && textTab && textTab.others_read >= last.id;

  const el = h('div.chat-item' + (c.id === S.current ? '.active' : ''), {
    dataset: { id: c.id },
    onclick: () => openChat(c.id),
  },
  avatar(av, { size: 52, online: c.type === 'dm' && c.peer && c.peer.online }),
  h('div.ci-body',
    h('div.ci-top',
      h('span.ci-title', c.type === 'group' ? icon('users', 'ci-kind') : null, h('span', title), c.muted ? icon('bellOff', 'ci-muted') : null),
      h('span.ci-time', own && last.kind !== 'system' && c.type !== 'saved' ? icon(read ? 'checks' : 'check', 'ci-ticks') : null, last ? fmtShort(last.ts) : '')),
    h('div.ci-bottom',
      h('span.ci-preview', preview),
      voice.length ? h('span.ci-voice', { title: 'Идёт голосовой чат' }, icon('speaker')) : null,
      unread ? h('span.badge' + (c.muted ? '.muted' : ''), unread > 999 ? '999+' : String(unread)) : null)));
  return el;
}

function renderList() {
  if (!listEl) return;
  const chats = sortedChats();
  clear(listEl, chats.map(chatItem));
  if (!chats.length) listEl.append(h('div.list-empty', 'Чатов пока нет'));
  if (query) renderSearch();
  updateTitle();
}

function updateTitle() {
  let total = 0;
  for (const c of S.chats.values()) if (!c.muted) total += chatUnread(c);
  document.title = (total ? `(${total}) ` : '') + 'TabChat';
}

/* ---------------- поиск ---------------- */

const searchUsers = debounce(async q => {
  if (q !== query) return;
  let users = [];
  try { users = await S.sock.call('users.search', { q }); } catch (e) { /* ignore */ }
  if (q !== query) return;
  const box = resultsEl.querySelector('.people');
  if (!box) return;
  clear(box);
  users.forEach(putUser);
  if (!users.length) box.append(h('div.list-empty', 'Никого не нашлось'));
  for (const u of users) {
    box.append(h('div.chat-item', { onclick: () => { clearSearch(); openDm(u.id); } },
      avatar(u, { size: 46, online: u.online }),
      h('div.ci-body',
        h('div.ci-top', h('span.ci-title', h('span', u.id === S.me.id ? 'Избранное' : u.name))),
        h('div.ci-bottom', h('span.ci-preview.accent', '@' + u.username)))));
  }
}, 220);

function clearSearch() {
  searchInput.value = '';
  query = '';
  renderSearch();
}

function renderSearch() {
  const active = !!query;
  listEl.hidden = active;
  resultsEl.hidden = !active;
  if (!active) return;
  const q = query.toLowerCase().replace(/^@/, '');
  const chats = sortedChats().filter(c => chatTitle(c).toLowerCase().includes(q) ||
    (c.peer && c.peer.username.toLowerCase().includes(q)));
  clear(resultsEl,
    chats.length ? h('div.section-title', 'Чаты') : null,
    chats.map(c => { const el = chatItem(c); el.onclick = () => { clearSearch(); openChat(c.id); }; return el; }),
    h('div.section-title', 'Люди'),
    h('div.people', h('div.list-empty', 'Ищем…')));
  searchUsers(query);
}

/* ---------------- меню ---------------- */

function openDrawer() {
  const me = S.me;
  const list = accounts.list();
  let showAccounts = false;
  const accBox = h('div.drawer-accounts', { hidden: true });

  const close = () => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 200); };
  const item = (ic, label, fn, extra) => h('button.drawer-item', { onclick: () => { close(); fn(); } }, icon(ic), h('span', label), extra || null);

  function renderAccounts() {
    clear(accBox,
      accounts.list().map(a => accountRow(a, {
        active: a.user.id === me.id,
        onclick: () => { if (a.user.id !== me.id) { accounts.setActive(a.user.id); location.reload(); } },
        onremove: () => { accounts.remove(a.user.id); forgetIdentity(a.user.id); renderAccounts(); },
      })),
      h('button.drawer-item', { onclick: () => { close(); emit('auth:add'); } }, icon('plus'), h('span', 'Добавить аккаунт')));
  }
  renderAccounts();

  const theme = prefs.get('theme', 'dark');
  const themeSwitch = h('span.switch' + (theme === 'dark' ? '.on' : ''));
  const panel = h('div.drawer',
    h('div.drawer-head',
      avatar(me, { size: 64 }),
      h('div.drawer-me',
        h('div.drawer-name', me.name),
        h('div.drawer-username', '@' + me.username)),
      h('button.icon-btn.drawer-acc-toggle', {
        title: 'Аккаунты',
        onclick: e => { showAccounts = !showAccounts; accBox.hidden = !showAccounts; e.currentTarget.classList.toggle('open', showAccounts); },
      }, icon('arrowDown')),
    ),
    accBox,
    h('div.drawer-items',
      item('link', 'Пригласить друзей', inviteDialog),
      item('user', 'Мой профиль', () => openSettings('profile')),
      item('users', 'Новая группа', newGroupDialog),
      item('map', 'Карта групп', () => openMapScreen()),
      item('bookmark', 'Избранное', openSaved),
      S.app ? item('devices', 'Сервер: ' + (S.app.server ? S.app.server.host : '—'), () => location.assign(S.app.launcher + '/')) : null,
      !S.app && S.server.client_app && /Windows/.test(navigator.userAgent)
        ? item('download', 'Приложение для Windows', () => downloadApp()) : null,
      h('button.drawer-item', { onclick: () => {
        const next = prefs.get('theme', 'dark') === 'dark' ? 'light' : 'dark';
        prefs.set('theme', next);
        applyTheme(next);
        themeSwitch.classList.toggle('on', next === 'dark');
      } }, icon('moon'), h('span', 'Ночной режим'), themeSwitch),
      item('settings', 'Настройки', () => openSettings()),
      item('devices', 'Устройства', () => openSettings('devices')),
      item('logout', 'Выйти', () => emit('auth:logout')),
    ),
    h('div.drawer-foot', 'TabChat · ', list.length > 1 ? `${list.length} аккаунта на устройстве` : 'мессенджер со вкладками'),
  );
  const wrap = h('div.drawer-wrap', { onmousedown: e => { if (e.target === wrap) close(); } }, panel);
  document.body.append(wrap);
}

/* ---------------- приложение для Windows ---------------- */

function downloadApp() {
  const mb = (S.server.client_app.size / 1024 / 1024).toFixed(1);
  const m = openModal({
    title: 'Приложение для Windows',
    body: h('div.modal-form',
      h('p.modal-text', 'TabChat в отдельном окне: уведомления, своя иконка, и код мессенджера хранится у вас, а не приходит с сервера при каждом открытии.'),
      h('p.muted.small-note', `Файл TabChat.exe, ${mb} МБ. Через бесплатный туннель скачивание может занять пару минут. ` +
        'Windows может предупредить о неизвестном издателе — нажмите «Подробнее» → «Выполнить в любом случае». ' +
        'При первом запуске вставьте ссылку на этот сервер.')),
    actions: [{ label: 'Скачать', primary: true, onclick: () => { location.href = '/download/windows'; m.close(); } }],
  });
}

/* ---------------- ссылка для друзей ---------------- */

export function inviteDialog() {
  const srv = S.server || {};
  const url = srv.public_url;
  const linkBox = u => h('div.invite-box.big', h('span.invite-link', u),
    h('button.icon-btn', { title: 'Скопировать', onclick: () => copyText(u, 'Ссылка скопирована') }, icon('copy')));
  const body = h('div.modal-form',
    url
      ? [h('p.modal-text', 'Отправьте эту ссылку друзьям — она открывается из любой сети, с телефона и компьютера.'),
        linkBox(url),
        h('p.muted.small-note', srv.tunnel === 'temp'
          ? 'Ссылка меняется при каждом запуске сервера — после перезапуска отправьте друзьям новую.'
          : 'Ссылка постоянная — её можно сохранить, после перезапуска TabChat она не изменится.')]
      : [h('p.modal-text', 'Ссылка для интернета ещё не готова: туннель подключается или выключен. Пока можно позвать тех, кто в вашей Wi‑Fi сети:'),
        (srv.lan_urls || []).slice(0, 1).map(linkBox)],
    h('p.muted.small-note', 'Друзья сами регистрируются по ссылке. Переписка защищена сквозным шифрованием.'));
  const m = openModal({ title: 'Пригласить друзей', body, actions: [{ label: 'Готово', primary: true, onclick: () => m.close() }] });
}

/* ---------------- новая группа ---------------- */

export function newGroupDialog() {
  const selected = new Map();
  const title = h('input.field', { placeholder: 'Название группы', maxlength: 64 });
  const chips = h('div.chips');
  const results = h('div.pick-list');
  const search = h('input.field', { placeholder: 'Добавить участников: имя или @username', type: 'search', autocomplete: 'off' });

  function renderChips() {
    clear(chips, [...selected.values()].map(u => h('span.chip', avatar(u, { size: 22 }), u.name,
      h('button', { type: 'button', onclick: () => { selected.delete(u.id); renderChips(); renderResults(lastUsers); } }, icon('x')))));
  }

  // для начала предлагаем тех, с кем уже есть личные чаты
  let lastUsers = [...S.chats.values()].filter(c => c.type === 'dm' && c.peer).map(c => c.peer);

  function renderResults(users) {
    lastUsers = users;
    clear(results, users.filter(u => u.id !== S.me.id).map(u => h('label.pick-item',
      h('input', { type: 'checkbox', checked: selected.has(u.id), onchange: e => {
        if (e.target.checked) selected.set(u.id, u); else selected.delete(u.id);
        renderChips();
      } }),
      avatar(u, { size: 36 }),
      h('div.pick-text', h('div', u.name), h('div.muted', '@' + u.username)))));
    if (!users.length) results.append(h('div.list-empty', search.value ? 'Никого не нашлось' : 'Найдите людей по имени или @username'));
  }

  search.addEventListener('input', debounce(async () => {
    const q = search.value.trim();
    if (!q) { renderResults([...S.chats.values()].filter(c => c.type === 'dm' && c.peer).map(c => c.peer)); return; }
    try { renderResults((await S.sock.call('users.search', { q })).map(putUser)); } catch (e) { /* ignore */ }
  }, 220));

  renderResults(lastUsers);
  const m = openModal({
    title: 'Новая группа',
    cls: 'wide',
    body: h('div.modal-form', title, search, chips, results),
    actions: [
      { label: 'Отмена', onclick: () => m.close() },
      { label: 'Создать', primary: true, onclick: async () => {
        if (!title.value.trim()) { title.focus(); toast('Укажите название группы'); return; }
        try {
          const chat = await S.sock.call('chats.create_group', { title: title.value.trim(), members: [...selected.keys()] });
          m.close();
          emit('chat:put', chat);
          openChat(chat.id);
        } catch (e) { toast(e.message); }
      } },
    ],
  });
}
