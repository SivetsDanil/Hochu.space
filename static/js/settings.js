// Настройки: профиль, оформление, уведомления, пароль, устройства.
import { S, emit, putUser, prefs } from './store.js';
import { upload, accounts } from './api.js';
import { h, clear, icon, avatar, toast, openModal, confirmDialog, fmtShort } from './ui.js';
import { squareImage } from './media.js';
import { applyTheme, applyAccent, ACCENTS } from './theme.js';
import * as e2e from './crypto.js';

const COLORS = ['#e17076', '#faa774', '#e5ca77', '#7bc862', '#6ec9cb', '#65aadd', '#7d8de3', '#a695e7', '#ee7aae', '#f2994a', '#4fc1a6', '#5fa8e8'];

function describeAgent(ua) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /YaBrowser/.test(ua) ? 'Яндекс Браузер'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

/** Тёмная / светлая / как в системе */
function themeChooser() {
  const cur = prefs.get('theme', 'dark');
  const btns = [['dark', 'moon', 'Тёмная'], ['light', 'sun', 'Светлая'], ['system', 'devices', 'Как в системе']].map(([id, ic, label]) =>
    h('button' + (cur === id ? '.active' : ''), { type: 'button', onclick: () => {
      prefs.set('theme', id);
      applyTheme(id);
      btns.forEach(b => b.classList.toggle('active', b === btn(id)));
    } }, icon(ic), label));
  const btn = id => btns[['dark', 'light', 'system'].indexOf(id)];
  return h('div.settings-block', h('div.field-label', 'Тема приложения'), h('div.segmented', btns));
}

/** Цвет акцента: кнопки, ссылки, выделенный чат */
function accentChooser() {
  const cur = prefs.get('accent', null);
  const dots = [null, ...ACCENTS].map(col => h('button.accent-dot' + (cur === col ? '.active' : ''), {
    type: 'button', title: col ? 'Акцент' : 'Как в теме', style: { background: col || 'conic-gradient(#5eb5f7, #4ee3a3, #f2b84b, #ff7aa2, #b39dff, #5eb5f7)' },
    onclick: e => {
      prefs.set('accent', col);
      applyAccent(col);
      dots.forEach(d => d.classList.toggle('active', d === e.currentTarget));
    },
  }));
  return h('div.settings-block', h('div.field-label', 'Цвет акцента'), h('div.accent-row', dots));
}

function toggleRow(ic, label, value, onchange, hint) {
  const sw = h('span.switch' + (value ? '.on' : ''));
  return h('button.settings-row', { onclick: async () => {
    const next = !sw.classList.contains('on');
    const ok = await onchange(next);
    if (ok !== false) sw.classList.toggle('on', next);
  } }, icon(ic), h('div.settings-text', h('div', label), hint ? h('div.muted', hint) : null), sw);
}

export function openSettings(section = 'profile') {
  const me = S.me;
  let avatarId = me.avatar;
  let color = me.color;

  /* ---- профиль ---- */
  const avBox = h('div.settings-avatar');
  const renderAv = () => clear(avBox, avatar({ name: name.value || me.name, color, avatar: avatarId }, { size: 96 }), h('span.avatar-edit-ic', icon('camera')));
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const blob = await squareImage(f);
      avatarId = (await upload(blob, 'avatar.jpg', S.token)).id;
      renderAv();
    } catch (e) { toast(e.message); }
  } });
  const name = h('input.field', { value: me.name, maxlength: 64, placeholder: 'Имя' });
  const username = h('input.field', { value: me.username, maxlength: 32, autocapitalize: 'off' });
  const bio = h('textarea.field', { rows: 2, maxlength: 200, placeholder: 'Пара слов о себе' });
  bio.value = me.bio || '';
  name.addEventListener('input', renderAv);
  const swatches = h('div.swatches', COLORS.map(c => h('button.swatch' + (c === color ? '.on' : ''), {
    type: 'button', style: { background: c }, title: 'Цвет профиля',
    onclick: e => { color = c; swatches.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s === e.currentTarget)); renderAv(); },
  })));
  renderAv();

  const saveProfile = async () => {
    try {
      const user = await S.sock.call('profile.update', {
        name: name.value, username: username.value, bio: bio.value, color, avatar: avatarId || null,
      });
      putUser(user);
      accounts.updateUser(user);
      emit('user', user.id);
      toast('Профиль сохранён');
    } catch (e) { toast(e.message); }
  };

  const profile = h('section.settings-section', { dataset: { s: 'profile' } },
    h('div.settings-profile',
      h('div.avatar-edit', { onclick: () => fileInput.click(), title: 'Сменить фото' }, avBox), fileInput,
      avatarId ? h('button.link-btn', { type: 'button', onclick: () => { avatarId = null; renderAv(); } }, 'Убрать фото') : null),
    h('label.field-wrap', h('span.field-label', 'Имя'), name),
    h('label.field-wrap', h('span.field-label', 'Имя пользователя'), h('div.field-group', h('span.field-prefix', '@'), username)),
    h('label.field-wrap', h('span.field-label', 'О себе'), bio),
    h('div.field-wrap', h('span.field-label', 'Цвет'), swatches),
    h('button.primary-btn', { onclick: saveProfile }, 'Сохранить профиль'));

  /* ---- оформление и уведомления ---- */
  const notifSupported = 'Notification' in window;
  const look = h('section.settings-section', { dataset: { s: 'look' } },
    h('h4', 'Оформление и уведомления'),
    themeChooser(),
    accentChooser(),
    toggleRow('bell', 'Уведомления на рабочем столе', notifSupported && Notification.permission === 'granted' && prefs.get('notify', true), async v => {
      if (!notifSupported) { toast('Браузер не поддерживает уведомления'); return false; }
      if (v && Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') { toast('Уведомления запрещены в настройках браузера'); return false; }
      }
      prefs.set('notify', v);
    }, notifSupported ? 'Когда вкладка с TabChat свёрнута' : 'Не поддерживается браузером'),
    toggleRow('speaker', 'Звук новых сообщений', prefs.get('sound', true), v => prefs.set('sound', v)),
    toggleRow('send', 'Отправка по Enter', prefs.get('enterSend', true), v => prefs.set('enterSend', v), 'Shift+Enter — новая строка'));

  /* ---- шифрование и пароль ---- */
  const fp = h('span.fingerprint', '…');
  e2e.myFingerprint().then(f => { fp.textContent = f; }).catch(() => { fp.textContent = 'ключи не загружены'; });
  const oldPw = h('input.field', { type: 'password', placeholder: 'Текущий пароль', autocomplete: 'current-password' });
  const newPw = h('input.field', { type: 'password', placeholder: 'Новый пароль (от 6 символов)', autocomplete: 'new-password' });
  const pwBtn = h('button.ghost-btn', { type: 'submit' }, icon('lock'), 'Сменить пароль');
  const security = h('section.settings-section', { dataset: { s: 'security' } },
    h('h4', 'Шифрование и безопасность'),
    h('div.settings-row.static', h('span.e2e-lock-big', '🔒'), h('div.settings-text',
      h('div', 'Сквозное шифрование включено'),
      h('div.muted', 'Сообщения, файлы, голосовые, кружки и звонки шифруются на вашем устройстве. Сервер хранит только шифротекст и не знает вашего пароля.'))),
    h('div.settings-row.static', icon('user'), h('div.settings-text', h('div', 'Отпечаток вашего ключа'), fp)),
    h('form.modal-form', { onsubmit: async e => {
      e.preventDefault();
      if (newPw.value.length < 6) { toast('Новый пароль должен быть не короче 6 символов'); return; }
      pwBtn.disabled = true;
      try {
        // пароль никуда не уходит: выводим старый auth, новый auth и перешифровываем копию ключей
        const info = await S.sock.call('keys.info');
        const old = await e2e.deriveFromPassword(oldPw.value, info.salt, info.iters);
        const salt = e2e.newSalt();
        const neu = await e2e.deriveFromPassword(newPw.value, salt, e2e.KDF_ITERS);
        const backup = await e2e.sealIdentity(e2e.identity(), neu.backupKey);
        await S.sock.call('auth.password', { old_auth: old.auth, auth: neu.auth, salt, iters: e2e.KDF_ITERS, backup });
        oldPw.value = newPw.value = '';
        toast('Пароль изменён');
      } catch (err) { toast(err.message); }
      pwBtn.disabled = false;
    } }, oldPw, newPw, pwBtn,
    h('div.muted.small-note', 'Пароль нельзя восстановить: без него переписку на новом устройстве не расшифровать.')));

  /* ---- устройства ---- */
  const devList = h('div.device-list', h('div.loading', h('div.spinner.small')));
  const loadDevices = async () => {
    try {
      const list = await S.sock.call('sessions.list');
      clear(devList, list.map(s => h('div.device-row',
        icon('devices'),
        h('div.settings-text',
          h('div', describeAgent(s.agent), s.current ? h('span.accent', ' · это устройство') : s.online ? h('span.green', ' · в сети') : null),
          h('div.muted', 'вход ' + fmtShort(s.created) + ' · активность ' + fmtShort(s.active))),
        s.current ? null : h('button.icon-btn.small', { title: 'Завершить сеанс', onclick: async () => {
          await S.sock.call('sessions.revoke', { id: s.id });
          loadDevices();
        } }, icon('x')))));
    } catch (e) { clear(devList, h('div.muted', e.message)); }
  };
  loadDevices();
  const devices = h('section.settings-section', { dataset: { s: 'devices' } },
    h('h4', 'Устройства'),
    devList,
    h('button.ghost-btn', { onclick: async () => {
      if (await confirmDialog('Выйти из аккаунта на всех остальных устройствах?', { ok: 'Завершить', danger: true })) {
        await S.sock.call('sessions.revoke', { others: true });
        loadDevices();
        toast('Остальные сеансы завершены');
      }
    } }, icon('logout'), 'Завершить все другие сеансы'));

  const logout = h('section.settings-section',
    h('button.danger-link', { onclick: () => { m.close(); emit('auth:logout'); } }, icon('logout'), 'Выйти из аккаунта'));

  const body = h('div.settings', profile, look, security, devices, logout);
  const m = openModal({ title: 'Настройки', cls: 'wide settings-modal', body });
  const target = body.querySelector(`[data-s="${section}"]`);
  if (target && section !== 'profile') setTimeout(() => target.scrollIntoView({ block: 'start' }), 50);
}
