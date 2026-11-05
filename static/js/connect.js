// Режим приложения TabChat.exe: страница открыта с 127.0.0.1, код клиента встроен в приложение,
// а к серверу ходит его локальный прокси. Здесь — экран выбора сервера и «пульс» окна.
import { $, h, clear, icon } from './ui.js';
import { LOGO } from './auth.js';

/** Сведения о приложении или null, если это обычный браузер (тогда лишних запросов не делаем). */
export async function loadAppInfo() {
  if (location.hostname !== '127.0.0.1') return null;
  try {
    const r = await fetch('/app/info', { cache: 'no-store' });
    if (!r.ok) return null;
    const info = await r.json();
    return info && info.app ? info : null;
  } catch (e) {
    return null;
  }
}

/** Приложение живёт, пока открыто хоть одно его окно: каждое держит это соединение. */
export function keepAlive() {
  const open = () => {
    const ws = new WebSocket(`ws://${location.host}/app/alive`);
    ws.onclose = () => setTimeout(open, 1500);
  };
  open();
}

async function connectTo(url) {
  const r = await fetch('/app/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TabChat-App': '1' }, body: JSON.stringify({ url }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не получилось подключиться');
  // у каждого сервера свой адрес 127.0.0.1:порт — а значит своё хранилище аккаунтов и ключей
  location.replace(data.server.origin + data.path);
}

export function connectScreen(info) {
  const input = h('input.field', { placeholder: 'https://….srv.us', autocomplete: 'off', spellcheck: false, autofocus: true });
  const error = h('div.form-error', { hidden: true });
  const btn = h('button.primary-btn.wide', { type: 'submit' }, 'Подключиться');

  async function go(url) {
    error.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Подключаемся…';
    try {
      await connectTo(url);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Подключиться';
    }
  }

  const servers = info.servers || [];
  const card = h('div.auth-card',
    LOGO(),
    h('h1', 'TabChat'),
    h('p.auth-sub', servers.length ? 'Выберите сервер или подключите новый' : 'Подключение к серверу'),
    servers.length ? h('div.server-list', servers.map(s => h('button.server-row', { type: 'button', onclick: () => location.assign(s.origin + '/') },
      h('span.server-ic', icon('chat')),
      h('span.server-text', h('b', s.public_url ? new URL(s.public_url).host : s.host), h('span', s.url)),
      icon('back', 'server-go')))) : null,
    info.local ? h('button.ghost-btn.wide.server-local', { type: 'button', onclick: () => go(info.local) },
      icon('devices'), `Этот компьютер — ${info.local.replace(/^https?:\/\//, '')}`) : null,
    h('form.auth-form', { onsubmit: e => { e.preventDefault(); go(input.value); } },
      h('label.field-wrap', h('span.field-label', servers.length ? 'Новый сервер' : 'Ссылка на сервер или приглашение'), input),
      error,
      btn),
    h('p.small-note.muted.connect-note',
      'Ссылку даёт тот, кто запустил TabChat Server: она показана в его окне. Подойдёт и ссылка-приглашение в группу.'));
  clear($('#root'), h('div.auth-screen', h('div.auth-bg'), card));
  input.focus();
}
