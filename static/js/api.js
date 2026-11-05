// Сеть: аккаунты в браузере, HTTP-запросы, загрузка файлов, WebSocket с RPC и переподключением.

const LS_ACCOUNTS = 'tc.accounts';
const LS_LAST = 'tc.last';
const SS_ACTIVE = 'tc.active';

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* приватный режим */ }
}

/**
 * Несколько аккаунтов в одном браузере (как в Telegram). Активный аккаунт запоминается
 * отдельно для каждой вкладки (sessionStorage) — удобно тестировать переписку с самим собой.
 */
export const accounts = {
  list: () => lsGet(LS_ACCOUNTS, []),
  get(uid) { return this.list().find(a => a.user.id === uid); },
  save(token, user) {
    const list = this.list().filter(a => a.user.id !== user.id);
    list.unshift({ token, user: { id: user.id, username: user.username, name: user.name, color: user.color, avatar: user.avatar } });
    lsSet(LS_ACCOUNTS, list);
  },
  updateUser(user) {
    const list = this.list();
    const a = list.find(x => x.user.id === user.id);
    if (a) { Object.assign(a.user, { username: user.username, name: user.name, color: user.color, avatar: user.avatar }); lsSet(LS_ACCOUNTS, list); }
  },
  remove(uid) { lsSet(LS_ACCOUNTS, this.list().filter(a => a.user.id !== uid)); },
  active() {
    let id = null;
    try { id = Number(sessionStorage.getItem(SS_ACTIVE)) || null; } catch (e) { /* ignore */ }
    const list = this.list();
    return list.find(a => a.user.id === id) || list.find(a => a.user.id === lsGet(LS_LAST, null)) || list[0] || null;
  },
  setActive(uid) {
    try { sessionStorage.setItem(SS_ACTIVE, String(uid)); } catch (e) { /* ignore */ }
    lsSet(LS_LAST, uid);
  },
};

export async function http(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  } catch (e) {
    throw new Error('Сервер недоступен');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
  return data;
}

/** Загрузка файла с прогрессом. Возвращает {id, mime, size, name} */
export function upload(blob, name, token, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(name || 'file'));
    if (onProgress) xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status === 200) resolve(data);
      else reject(new Error(data.error || 'Не удалось загрузить файл'));
    };
    xhr.onerror = () => reject(new Error('Сервер недоступен'));
    xhr.send(blob);
  });
}

/** WebSocket: call(method, params) → Promise, on(event, fn), автопереподключение. */
export class Socket {
  constructor(token, { onEvent, onStatus, onAuthFail, onReady }) {
    this.token = token;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onAuthFail = onAuthFail;
    this.onReady = onReady;
    this.seq = 1;
    this.pending = new Map();
    this.closed = false;
    this.retry = 0;
    this.ready = false;
    this.timer = null;
    // Через туннель соединение может «зависнуть» без закрытия (туннель переподключился, ноутбук уснул):
    // раз в 15 секунд проверяем связь, а при возврате сети или вкладки — сразу.
    this.watchdog = setInterval(() => this.check(10000), 15000);
    this.wake = () => {
      if (this.closed || document.visibilityState !== 'visible') return;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; this.connect(); } else this.check(5000);
    };
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
    this.connect();
  }

  connect() {
    this.timer = null;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    this.ready = false;
    this.onStatus && this.onStatus('connecting');
    ws.onopen = () => {
      const id = this.seq++;
      this.pending.set(id, {
        resolve: res => {
          this.ready = true;
          this.retry = 0;
          this.onStatus && this.onStatus('online');
          this.onReady && this.onReady(res);
        },
        reject: () => {},
      });
      ws.send(JSON.stringify({ id, m: 'auth', p: { token: this.token } }));
    };
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.ev) { this.onEvent && this.onEvent(msg.ev, msg.d); return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('err' in msg) {
        if (msg.err === 'auth') { this.closed = true; this.onAuthFail && this.onAuthFail(); }
        p.reject(new Error(msg.err));
      } else p.resolve(msg.ok);
    };
    ws.onclose = e => {
      if (this.ws !== ws) return;
      this.ready = false;
      for (const p of this.pending.values()) p.reject(new Error('Нет соединения'));
      this.pending.clear();
      if (e.code === 4001) { this.closed = true; this.onAuthFail && this.onAuthFail(); return; }
      if (this.closed) return;
      this.onStatus && this.onStatus('offline');
      const delay = Math.min(10000, 600 * 2 ** this.retry++);
      this.timer = setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  /** Сервер не ответил на ping вовремя — бросаем это соединение и сразу открываем новое. */
  async check(timeoutMs) {
    if (this.closed || !this.ready || this.checking) return;
    this.checking = true;
    const ws = this.ws;
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve('late'), timeoutMs); });
    try {
      const res = await Promise.race([this.call('ping').catch(() => 'error'), late]);
      if (res === 'late' && this.ws === ws) this.reconnectNow();
    } finally {
      clearTimeout(timer);
      this.checking = false;
    }
  }

  reconnectNow() {
    if (this.closed) return;
    const old = this.ws;
    this.ws = null;                 // onclose старого соединения теперь ничего не делает
    this.ready = false;
    for (const p of this.pending.values()) p.reject(new Error('Нет соединения'));
    this.pending.clear();
    try { old && old.close(); } catch (e) { /* ignore */ }
    this.retry = 0;
    this.connect();
  }

  call(m, p = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) {
        reject(new Error('Нет соединения с сервером'));
        return;
      }
      const id = this.seq++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, m, p }));
    });
  }

  /** Отправка без ожидания ответа (typing, speaking) */
  fire(m, p = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) this.ws.send(JSON.stringify({ m, p }));
  }

  close() {
    this.closed = true;
    clearInterval(this.watchdog);
    clearTimeout(this.timer);
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}
