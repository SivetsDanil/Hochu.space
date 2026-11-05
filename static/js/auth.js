// Экран входа и регистрации. Пароль превращается в ключи прямо здесь и на сервер не уходит.
import { http } from './api.js';
import { $, h, clear, icon, debounce, avatar } from './ui.js';
import {
  supported, deriveFromPassword, openIdentity, newAccountBundle, saveIdentity,
} from './crypto.js';

export const LOGO = () => h('div.auth-logo', icon('chat'));

/** Вход: новый аккаунт — по ключу из пароля; старый — в последний раз паролем, сразу с переходом на шифрование */
export async function signIn(username, password) {
  const pre = await http('/api/prelogin', { username });
  if (pre.kdf === 'legacy') {
    const b = await newAccountBundle(password);
    const res = await http('/api/login', {
      username, password, upgrade: { auth: b.auth, salt: b.salt, iters: b.iters, keys: b.keys },
    });
    await saveIdentity(res.user.id, b.id);
    return res;
  }
  const { auth, backupKey } = await deriveFromPassword(password, pre.salt, pre.iters);
  const res = await http('/api/login', { username, auth });
  if (!res.backup) throw new Error('На сервере нет ключей шифрования этого аккаунта');
  await saveIdentity(res.user.id, await openIdentity(res.backup, backupKey));
  return res;
}

function insecureScreen(root) {
  const https = location.protocol === 'http:' ? location.href.replace(/^http:/, 'https:').replace(/:8080\b/, ':8443') : null;
  clear(root, h('div.auth-screen', h('div.auth-bg'), h('div.auth-card',
    h('div.auth-logo', icon('lock')),
    h('h1', 'Нужна защищённая ссылка'),
    h('p.auth-sub', 'Переписка в TabChat зашифрована сквозным шифрованием, а браузер даёт доступ к шифрованию только по https или на этом же компьютере (localhost).'),
    https ? h('a.primary-btn.wide', { href: https }, 'Открыть по https') : null,
    h('p.auth-sub', 'Ссылки для других устройств печатаются в окне TabChat при запуске.'))));
}

/**
 * showAuth({onDone(token, user), onBack?, saved: [accounts]})
 */
export function showAuth({ onDone, onBack, saved = [] }) {
  const root = $('#root');
  if (!supported()) { insecureScreen(root); return; }
  let mode = saved.length ? 'login' : 'register';

  const card = h('div.auth-card');
  const screen = h('div.auth-screen', h('div.auth-bg'), card);
  clear(root, screen);

  function render() {
    clear(card);
    if (onBack) card.append(h('button.icon-btn.auth-back', { onclick: onBack, title: 'Назад' }, icon('back')));
    card.append(
      LOGO(),
      h('h1', 'TabChat'),
      h('p.auth-sub', mode === 'login' ? 'Войдите в аккаунт' : 'Создайте аккаунт — это займёт полминуты'),
      h('div.segmented',
        h('button', { type: 'button', class: mode === 'login' ? 'active' : '', onclick: () => { mode = 'login'; render(); } }, 'Вход'),
        h('button', { type: 'button', class: mode === 'register' ? 'active' : '', onclick: () => { mode = 'register'; render(); } }, 'Регистрация')),
      mode === 'login' ? loginForm() : registerForm(),
    );
  }

  function field(label, input, hint) {
    return h('label.field-wrap', h('span.field-label', label), input, hint || null);
  }

  function errorBox() {
    return h('div.form-error', { hidden: true });
  }

  function showError(box, text) {
    box.textContent = text;
    box.hidden = !text;
  }

  function passwordInput(autocomplete) {
    const input = h('input.field', { type: 'password', autocomplete, required: true, minlength: 6, placeholder: '••••••' });
    const toggle = h('button.field-eye', { type: 'button', tabindex: -1, title: 'Показать пароль', onclick: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    } }, icon('eye'));
    return { input, el: h('div.field-group', input, toggle) };
  }

  function loginForm() {
    const username = h('input.field', { autocomplete: 'username', required: true, placeholder: 'username', autocapitalize: 'off', spellcheck: false });
    const pw = passwordInput('current-password');
    const err = errorBox();
    const btn = h('button.primary-btn.wide', { type: 'submit' }, 'Войти');
    const form = h('form.auth-form', {
      onsubmit: async e => {
        e.preventDefault();
        showError(err, '');
        btn.disabled = true;
        btn.textContent = 'Проверяем…';
        try {
          const res = await signIn(username.value.trim(), pw.input.value);
          onDone(res.token, res.user);
        } catch (ex) {
          showError(err, ex.message);
          btn.disabled = false;
          btn.textContent = 'Войти';
        }
      },
    },
    field('Имя пользователя', h('div.field-group', h('span.field-prefix', '@'), username)),
    field('Пароль', pw.el),
    err, btn);
    return form;
  }

  function registerForm() {
    const name = h('input.field', { autocomplete: 'name', required: true, maxlength: 64, placeholder: 'Как вас зовут' });
    const username = h('input.field', { autocomplete: 'username', required: true, maxlength: 32, placeholder: 'username', autocapitalize: 'off', spellcheck: false });
    const hint = h('span.field-hint', 'Латиница, цифры и _, от 3 символов. По нему вас найдут.');
    const pw = passwordInput('new-password');
    const err = errorBox();
    const btn = h('button.primary-btn.wide', { type: 'submit' }, 'Создать аккаунт');

    const check = debounce(async () => {
      const v = username.value.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(v)) {
        hint.textContent = v ? 'Только латиница, цифры и _, первая — буква, 3–32 символа' : 'Латиница, цифры и _, от 3 символов. По нему вас найдут.';
        hint.className = 'field-hint' + (v ? ' bad' : '');
        return;
      }
      try {
        const r = await fetch('/api/username?u=' + encodeURIComponent(v)).then(x => x.json());
        if (username.value.trim() !== v) return;
        hint.textContent = r.free ? `@${v} свободен` : `@${v} уже занят`;
        hint.className = 'field-hint ' + (r.free ? 'good' : 'bad');
      } catch (e) { /* ignore */ }
    }, 300);
    username.addEventListener('input', check);
    // подсказываем username из имени
    name.addEventListener('input', () => {
      if (username.dataset.touched) return;
      const tr = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
      const v = [...name.value.toLowerCase()].map(ch => tr[ch] ?? ch).join('').replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 24);
      username.value = v;
      check();
    });
    username.addEventListener('keydown', () => { username.dataset.touched = '1'; });

    return h('form.auth-form', {
      onsubmit: async e => {
        e.preventDefault();
        showError(err, '');
        if (pw.input.value.length < 6) { showError(err, 'Пароль должен быть не короче 6 символов'); return; }
        btn.disabled = true;
        btn.textContent = 'Создаём ключи шифрования…';
        try {
          const b = await newAccountBundle(pw.input.value);
          const res = await http('/api/register', {
            name: name.value.trim(), username: username.value.trim(),
            auth: b.auth, salt: b.salt, iters: b.iters, keys: b.keys,
          });
          await saveIdentity(res.user.id, b.id);
          onDone(res.token, res.user);
        } catch (ex) {
          showError(err, ex.message);
          btn.disabled = false;
          btn.textContent = 'Создать аккаунт';
        }
      },
    },
    field('Имя', name),
    field('Имя пользователя', h('div.field-group', h('span.field-prefix', '@'), username), hint),
    field('Пароль', pw.el, h('span.field-hint', 'Не короче 6 символов. Пароль не уходит на сервер и восстановить его нельзя — без него переписку не расшифровать.')),
    err, btn);
  }

  render();
}

/** Небольшая плашка с сохранёнными аккаунтами для меню */
export function accountRow(acc, { active, onclick, onremove }) {
  return h('div.account-row' + (active ? '.active' : ''), { onclick },
    avatar(acc.user, { size: 34 }),
    h('div.account-text', h('div.account-name', acc.user.name), h('div.account-sub', '@' + acc.user.username)),
    active ? icon('check', 'accent') : onremove ? h('button.icon-btn.small', { title: 'Убрать аккаунт с этого устройства', onclick: e => { e.stopPropagation(); onremove(); } }, icon('x')) : null);
}
