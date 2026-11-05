// Правая панель «Информация»: группа, участники, роли, приглашение; профиль пользователя.
import { S, on, emit, putUser, chatAvatar, isAdmin, shareOrigin } from './store.js';
import { upload } from './api.js';
import {
  $, h, clear, icon, avatar, fmtLastSeen, toast, openModal, showMenu, confirmDialog, copyText, debounce, plural,
} from './ui.js';
import { squareImage } from './media.js';
import * as e2e from './crypto.js';
import { openMapScreen, placeDialog, requestsDialog } from './places.js';
import { THEMES, chatThemeId, themeName, themeDialog, chatBackground, palette } from './themes.js';

let panel = null;
let openFor = null;
let members = [];

export function initInfo() {
  panel = $('#info-panel');
  on('chats', () => { if (openFor) render(false); });
  on('presence', () => { if (openFor) render(false); });
  on('user', () => { if (openFor) render(false); });
}

export function toggleInfo(force) {
  if (openFor && !force) { closeInfo(); return; }
  if (!S.current) return;
  openFor = S.current;
  panel.hidden = false;
  $('#app').classList.add('info-open');
  render(true);
}

export function closeInfo() {
  openFor = null;
  if (panel) panel.hidden = true;
  const app = $('#app');
  if (app) app.classList.remove('info-open');
}

async function loadMembers(chatId) {
  try {
    members = await S.sock.call('chats.members', { id: chatId });
    members.forEach(m => { m.user = putUser(m.user); });
    if (openFor === chatId) render(false);
  } catch (e) { /* ignore */ }
}

function render(reload) {
  const c = S.chats.get(openFor);
  if (!c) { closeInfo(); return; }
  if (reload) members = [];
  if (c.type === 'group' && (reload || members.length !== c.members)) loadMembers(c.id);
  const body = h('div.info-body');
  clear(panel,
    h('div.info-top', h('span', c.type === 'group' ? 'Информация о группе' : c.type === 'dm' ? 'Профиль' : 'Избранное'),
      h('button.icon-btn', { title: 'Закрыть', onclick: closeInfo }, icon('x'))),
    body);
  if (c.type === 'group') renderGroup(body, c);
  else if (c.type === 'dm') renderUser(body, c.peer, c);
  else body.append(h('div.info-hero', avatar(chatAvatar(c), { size: 96 }), h('div.info-title', 'Избранное'),
    h('div.info-sub', 'Ваше личное облако: заметки, файлы, голосовые и кружки. Видите только вы.')));
  // оформление — в любом чате; ставим после блока о шифровании, ближе к верху
  const look = lookSection(c);
  const anchor = body.querySelector('.info-section');
  if (anchor) anchor.before(look); else body.append(look);
}

function heroAvatar(entity, editable, onPick) {
  const av = avatar(entity, { size: 104 });
  if (!editable) return av;
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => { if (input.files[0]) onPick(input.files[0]); input.value = ''; } });
  return h('div.avatar-edit', { title: 'Сменить фото', onclick: () => input.click() }, av, h('span.avatar-edit-ic', icon('camera')), input);
}

async function uploadAvatar(file) {
  const blob = await squareImage(file);
  return (await upload(blob, 'avatar.jpg', S.token)).id;
}

function actionBtn(ic, label, onclick, cls = '') {
  return h('button.info-action' + cls, { onclick }, icon(ic), h('span', label));
}

function renderGroup(body, c) {
  const admin = isAdmin(c);
  const link = `${shareOrigin()}/join/${c.invite}`;
  // h() пропускает null, а родной append() превратил бы его в текст «null»
  body.append(...[
    h('div.info-hero',
      heroAvatar(chatAvatar(c), admin, async file => {
        try { await S.sock.call('chats.update', { id: c.id, avatar: await uploadAvatar(file) }); } catch (e) { toast(e.message); }
      }),
      h('div.info-title', c.title),
      h('div.info-sub', `${c.members} ${plural(c.members, 'участник', 'участника', 'участников')}`)),
    c.about ? h('div.info-about', c.about) : null,
    h('div.info-actions',
      actionBtn(c.muted ? 'bellOff' : 'bell', c.muted ? 'Без звука' : 'Звук', () => S.sock.call('chats.mute', { id: c.id, muted: !c.muted })),
      actionBtn('link', 'Ссылка', () => copyText(link, 'Ссылка-приглашение скопирована')),
      actionBtn('userPlus', 'Добавить', () => addMembersDialog(c)),
      admin ? actionBtn('edit', 'Изменить', () => editGroupDialog(c)) : null),
    h('div.info-section',
      h('div.info-row.static', icon('lock'), h('div',
        h('div', 'Сквозное шифрование'),
        h('div.info-label', 'Сообщения, файлы и звонки видят только участники. Когда кто-то выходит, ключ группы меняется. ' +
          'Серверу видны название, аватар и состав группы.')))),
    h('div.info-section',
      h('div.info-label', 'Ссылка-приглашение'),
      h('div.invite-box', h('span.invite-link', link), h('button.icon-btn', { title: 'Скопировать', onclick: () => copyText(link, 'Ссылка скопирована') }, icon('copy'))),
      admin ? h('button.link-btn', { onclick: async () => {
        if (await confirmDialog('Старая ссылка перестанет работать. Сбросить?', { ok: 'Сбросить', danger: true })) {
          S.sock.call('chats.reset_invite', { id: c.id }).then(() => toast('Новая ссылка готова')).catch(e => toast(e.message));
        }
      } }, 'Сбросить ссылку') : null),
    placeSection(c, admin),
    h('div.info-section',
      h('div.info-label', 'Вкладки'),
      h('div.info-tabs', c.tabs.map(t => h('span.info-tab', icon(t.kind === 'voice' ? 'speaker' : 'hash'), t.name)))),
  ].filter(Boolean));

  const list = h('div.member-list');
  const sorted = [...members].sort((a, b) => roleRank(a.role) - roleRank(b.role) || (b.user.online - a.user.online) || a.user.name.localeCompare(b.user.name, 'ru'));
  for (const m of sorted) {
    const u = m.user;
    list.append(h('div.member-row', {
      onclick: () => openUserProfile(u.id),
      oncontextmenu: e => { e.preventDefault(); memberMenu(e, c, m); },
    },
    avatar(u, { size: 40, online: u.online }),
    h('div.member-text',
      h('div.member-name', u.name, u.id === S.me.id ? h('span.muted', ' (вы)') : null),
      h('div.member-sub' + (u.online ? '.accent' : ''), fmtLastSeen(u))),
    m.role !== 'member' ? h('span.role-badge' + (m.role === 'owner' ? '.owner' : ''), m.role === 'owner' ? 'владелец' : 'админ') : null,
    admin && u.id !== S.me.id && m.role !== 'owner' ? h('button.icon-btn.small', { title: 'Действия', onclick: e => { e.stopPropagation(); memberMenu(e, c, m); } }, icon('more')) : null));
  }
  body.append(h('div.info-section', h('div.info-label', `Участники · ${c.members}`), members.length ? list : h('div.loading', h('div.spinner.small'))));

  body.append(h('div.info-section.danger-zone',
    h('button.danger-link', { onclick: async () => {
      if (await confirmDialog(`Покинуть группу «${c.title}»?`, { ok: 'Покинуть', danger: true })) S.sock.call('chats.leave', { id: c.id }).catch(e => toast(e.message));
    } }, icon('door'), 'Покинуть группу'),
    c.role === 'owner' ? h('button.danger-link', { onclick: async () => {
      if (await confirmDialog(`Удалить группу «${c.title}» у всех участников? Это нельзя отменить.`, { ok: 'Удалить', danger: true })) {
        S.sock.call('chats.delete', { id: c.id }).catch(e => toast(e.message));
      }
    } }, icon('trash'), 'Удалить группу') : null));
}

/** Место на карте и заявки на вступление: с карты в группу просятся незнакомые люди. */
function placeSection(c, admin) {
  const pl = c.place;
  if (!pl && !admin) return null;
  return h('div.info-section',
    h('div.info-label', 'Место на карте'),
    pl
      ? h('div.info-row', { onclick: () => openMapScreen({ chat: c.id, lat: pl.lat, lon: pl.lon }) }, icon('pin'),
        h('div', h('div', pl.address || 'Место без подписи'), h('div.info-label', 'Показать на карте')))
      : h('div.info-row.static', icon('pin'),
        h('div', h('div', 'Группы нет на карте'), h('div.info-label', 'Отметьте место — и группу найдут люди рядом. Они смогут подать заявку на вступление.'))),
    admin ? h('button.link-btn', { onclick: () => placeDialog(c) }, pl ? 'Изменить место' : 'Отметить на карте') : null,
    admin && (pl || c.requests)
      ? h('div.info-row', { onclick: () => requestsDialog(c) }, icon('userPlus'),
        h('div', h('div', 'Заявки на вступление'), h('div.info-label', c.requests ? 'Ждут ответа' : 'Новых нет')),
        c.requests ? h('span.badge', String(c.requests)) : null)
      : null);
}

const GROUP_EMOJI = ['🏠', '🌳', '⚽', '🎮', '🎵', '📚', '🍕', '☕', '🚗', '🐱', '🐶', '💼', '🎓', '🏃', '🎉', '❤️',
  '🔥', '⭐', '💬', '🛠', '🌍', '🏡', '🎨', '📷'];
const GROUP_COLORS = ['#e17076', '#faa774', '#e5ca77', '#7bc862', '#6ec9cb', '#65aadd', '#7d8de3', '#a695e7', '#ee7aae', '#4fc1a6'];

function lookSection(c) {
  const id = chatThemeId(c);
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  const p = palette(t);
  return h('div.info-section',
    h('div.info-row', { onclick: () => themeDialog(c) },
      h('span.theme-swatch', { style: { background: chatBackground(t, p) } },
        h('i', { style: { background: `linear-gradient(135deg, ${p.own[0]}, ${p.own[1]})` } })),
      h('div', h('div', 'Оформление чата'), h('div.info-label', themeName(id) + (c.my_theme ? ' · только у вас' : '')))));
}

const roleRank = r => ({ owner: 0, admin: 1 }[r] ?? 2);

function memberMenu(e, c, m) {
  const me = c.role;
  const u = m.user;
  if (u.id === S.me.id) return;
  const canKick = (me === 'owner' && m.role !== 'owner') || (me === 'admin' && m.role === 'member');
  showMenu(e.clientX, e.clientY, [
    { icon: 'user', label: 'Профиль', onclick: () => openUserProfile(u.id) },
    { icon: 'chat', label: 'Написать', onclick: () => emit('open-dm', u.id) },
    me === 'owner' && m.role === 'member' ? { icon: 'shield', label: 'Сделать админом', onclick: () => setRole(c, u, 'admin') } : null,
    me === 'owner' && m.role === 'admin' ? { icon: 'shield', label: 'Снять админа', onclick: () => setRole(c, u, 'member') } : null,
    canKick ? { icon: 'trash', label: 'Удалить из группы', danger: true, onclick: async () => {
      if (await confirmDialog(`Удалить ${u.name} из группы?`, { ok: 'Удалить', danger: true })) S.sock.call('chats.kick', { id: c.id, user: u.id }).catch(err => toast(err.message));
    } } : null,
  ]);
}

async function setRole(c, u, role) {
  try {
    await S.sock.call('chats.set_role', { id: c.id, user: u.id, role });
    const m = members.find(x => x.user.id === u.id);
    if (m) m.role = role;
    render(false);
  } catch (e) { toast(e.message); }
}

function renderUser(body, u, chat) {
  if (!u) { body.append(h('div.info-sub', 'Аккаунт удалён')); return; }
  body.append(
    h('div.info-hero', avatar(u, { size: 104 }), h('div.info-title', u.name), h('div.info-sub' + (u.online ? '.accent' : ''), fmtLastSeen(u))),
    h('div.info-actions',
      actionBtn('phone', 'Позвонить', () => emit('start-call', chat.id)),
      actionBtn(chat.muted ? 'bellOff' : 'bell', chat.muted ? 'Без звука' : 'Звук', () => S.sock.call('chats.mute', { id: chat.id, muted: !chat.muted }))),
    h('div.info-section',
      h('div.info-row', { onclick: () => copyText('@' + u.username, 'Имя пользователя скопировано') }, icon('user'), h('div', h('div', '@' + u.username), h('div.info-label', 'Имя пользователя'))),
      u.bio ? h('div.info-row', icon('info'), h('div', h('div.pre', u.bio), h('div.info-label', 'О себе'))) : null,
      safetyRow(u)));
}

/* ---------------- код безопасности ---------------- */

/** Сверка ключей с собеседником: одинаковый код у обоих = никто не вклинился посередине */
export async function openSafetyCode(user) {
  const peer = await e2e.safetyKeysOf(user.id);
  const me = e2e.identity();
  if (!peer || !me) { toast(peer ? 'Ключи этого устройства ещё не готовы' : `${user.name} ещё не включил(а) шифрование`); return; }
  const code = await e2e.safetyCode(me, peer);
  const trust = (await e2e.trustOf(user.id)) || {};
  const status = h('div.safety-status' + (trust.verified ? '.ok' : ''),
    trust.verified ? '✓ Вы отметили этот код как проверенный' : trust.changed ? '⚠️ Ключ собеседника менялся — сверьте код' : 'Код ещё не проверен');
  const m = openModal({
    title: 'Код безопасности',
    cls: 'safety-modal',
    body: h('div.safety',
      h('div.safety-emoji', code.emoji.map(e => h('span', e))),
      h('div.safety-digits', code.digits),
      h('p.modal-text.muted', `Сравните эмодзи или цифры с ${user.name} при встрече или по видеосвязи. ` +
        'Если они совпадают — переписку и звонки с этим человеком никто не может прочитать, даже сервер.'),
      status),
    actions: [
      { label: 'Закрыть', onclick: () => m.close() },
      trust.verified
        ? { label: 'Снять отметку', onclick: async () => { await e2e.setVerified(user.id, false); m.close(); } }
        : { label: 'Коды совпадают', primary: true, onclick: async () => { await e2e.setVerified(user.id, true); toast('Отмечено как проверенное'); m.close(); } },
    ],
  });
}

function safetyRow(user) {
  return h('div.info-row', { onclick: () => openSafetyCode(user) }, icon('lock'),
    h('div', h('div', 'Код безопасности'), h('div.info-label', 'Сверить ключи шифрования')));
}

/* ---------------- диалоги ---------------- */

export async function openUserProfile(userId) {
  let u = S.users.get(userId);
  try { u = putUser(await S.sock.call('users.get', { id: userId })); } catch (e) { if (!u) return toast(e.message); }
  const self = u.id === S.me.id;
  const m = openModal({
    cls: 'profile-modal',
    body: h('div.profile-card',
      avatar(u, { size: 110, online: u.online }),
      h('div.profile-name', u.name),
      h('div.profile-status' + (u.online ? '.accent' : ''), self ? 'это вы' : fmtLastSeen(u)),
      h('div.profile-rows',
        h('div.info-row', { onclick: () => copyText('@' + u.username, 'Скопировано') }, icon('user'), h('div', h('div', '@' + u.username), h('div.info-label', 'Имя пользователя'))),
        u.bio ? h('div.info-row', icon('info'), h('div', h('div.pre', u.bio), h('div.info-label', 'О себе'))) : null,
        self ? null : safetyRow(u)),
      h('div.profile-actions',
        h('button.primary-btn', { onclick: () => { m.close(); emit('open-dm', u.id); } }, icon(self ? 'bookmark' : 'chat'), self ? 'Избранное' : 'Написать'),
        self ? null : h('button.ghost-btn', { onclick: () => { m.close(); emit('call-user', u.id); } }, icon('phone'), 'Позвонить'))),
  });
}

function editGroupDialog(c) {
  const title = h('input.field', { value: c.title, maxlength: 64, placeholder: 'Название' });
  const about = h('textarea.field', { maxlength: 300, rows: 3, placeholder: 'Описание группы (необязательно)' });
  about.value = c.about || '';
  // аватарка без фото: эмодзи на цветном круге
  let emoji = c.emoji || '', color = c.color;
  const preview = h('div.emoji-preview');
  const drawPreview = () => clear(preview, avatar({ title: title.value || c.title, color, emoji }, { size: 64 }));
  const emojiGrid = h('div.emoji-grid', ['', ...GROUP_EMOJI].map(e => h('button.emoji-pick', {
    type: 'button', title: e ? e : 'Буквы названия', onclick: () => { emoji = e; drawPreview(); },
  }, e || 'Аб')));
  const colorRow = h('div.color-row', GROUP_COLORS.map(col => h('button.color-pick', {
    type: 'button', style: { background: col }, onclick: () => { color = col; drawPreview(); },
  })));
  title.addEventListener('input', drawPreview);
  drawPreview();
  const save = async () => {
    try {
      await S.sock.call('chats.update', { id: c.id, title: title.value, about: about.value, emoji, color });
      m.close();
    } catch (e) { toast(e.message); }
  };
  const m = openModal({
    title: 'Изменить группу',
    body: h('form.modal-form', { onsubmit: e => { e.preventDefault(); save(); } }, title, about,
      h('div.field-label', 'Аватарка'), h('div.emoji-row', preview, h('div.emoji-side', emojiGrid, colorRow)),
      c.avatar ? h('p.muted.small-note', 'Сейчас стоит фото — эмодзи появится, если убрать его.') : null),
    actions: [
      c.avatar ? { label: 'Убрать фото', onclick: () => { S.sock.call('chats.update', { id: c.id, avatar: null }); m.close(); } } : null,
      { label: 'Отмена', onclick: () => m.close() },
      { label: 'Сохранить', primary: true, onclick: save },
    ].filter(Boolean),
  });
}

function addMembersDialog(c) {
  const selected = new Map();
  const search = h('input.field', { placeholder: 'Имя или @username', type: 'search', autocomplete: 'off' });
  const results = h('div.pick-list');
  const memberIds = new Set(members.map(m => m.user.id));
  const renderResults = users => {
    clear(results, users.filter(u => u.id !== S.me.id).map(u => {
      const already = memberIds.has(u.id);
      return h('label.pick-item' + (already ? '.disabled' : ''),
        h('input', { type: 'checkbox', checked: already || selected.has(u.id), disabled: already, onchange: e => {
          if (e.target.checked) selected.set(u.id, u); else selected.delete(u.id);
        } }),
        avatar(u, { size: 36 }),
        h('div.pick-text', h('div', u.name), h('div.muted', already ? 'уже в группе' : '@' + u.username)));
    }));
    if (!results.children.length) results.append(h('div.list-empty', 'Найдите людей по имени или @username'));
  };
  const known = () => [...S.chats.values()].filter(x => x.type === 'dm' && x.peer).map(x => x.peer);
  search.addEventListener('input', debounce(async () => {
    const q = search.value.trim();
    if (!q) return renderResults(known());
    try { renderResults((await S.sock.call('users.search', { q })).map(putUser)); } catch (e) { /* ignore */ }
  }, 220));
  renderResults(known());
  const m = openModal({
    title: 'Добавить участников', cls: 'wide',
    body: h('div.modal-form', search, results),
    actions: [
      { label: 'Отмена', onclick: () => m.close() },
      { label: 'Добавить', primary: true, onclick: async () => {
        if (!selected.size) return m.close();
        try {
          const n = await S.sock.call('chats.add_members', { id: c.id, users: [...selected.keys()] });
          toast(`Добавлено: ${n}`);
          m.close();
          loadMembers(c.id);
        } catch (e) { toast(e.message); }
      } },
    ],
  });
}
