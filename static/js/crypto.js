// Сквозное шифрование TabChat. Всё на WebCrypto, ключи не покидают браузер в открытом виде.
//
//   пароль ─PBKDF2─▶ master ─HKDF─┬─▶ auth      → на сервер (вместо пароля, там хранится его хэш)
//                                 └─▶ backupKey → шифрует копию личных ключей (сервер её не прочитает)
//
//   личные ключи: ECDH P-256 (обмен) + ECDSA P-256 (подпись)
//   ключ чата (AES-256-GCM) по «эпохам»: для каждого участника завёрнут через ECDH(отправитель, участник)
//   сообщение: AES-GCM(ключ эпохи, JSON{текст, файл}) + подпись ECDSA отправителя
//   файл: свой случайный AES-ключ, он лежит внутри зашифрованного сообщения
//   звонок: DTLS-отпечатки в SDP подписываются личным ключом + эмодзи-код для сверки
import { S, putUser, emit } from './store.js';

const subtle = globalThis.crypto && globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const KDF_ITERS = 310000;
export const supported = () => !!subtle && !!globalThis.indexedDB;

/* ============================================================ байты */

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const rand = n => crypto.getRandomValues(new Uint8Array(n));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

function concat(...parts) {
  const arrs = parts.map(p => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const aesKey = (raw, usages = ['encrypt', 'decrypt']) => subtle.importKey('raw', raw, 'AES-GCM', false, usages);

/* ============================================================ пароль */

export const newSalt = () => toB64(rand(16));

/** Из пароля: auth (hex) для входа и ключ для копии личных ключей */
export async function deriveFromPassword(password, saltB64, iters) {
  const base = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations: iters }, base, 256);
  const hk = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdf = info => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) });
  const auth = hex(await subtle.deriveBits(hkdf('tabchat/auth/v1'), hk, 256));
  const backupKey = await subtle.deriveKey(hkdf('tabchat/backup/v1'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { auth, backupKey };
}

/* ============================================================ личные ключи */

async function describeIdentity(ecdhPriv, signPriv, ecdhPub, signPub) {
  return {
    ecdhPriv, signPriv,
    ke: toB64(await subtle.exportKey('raw', ecdhPub)),
    ks: toB64(await subtle.exportKey('raw', signPub)),
  };
}

export async function generateIdentity() {
  const ecdh = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const sign = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  return describeIdentity(ecdh.privateKey, sign.privateKey, ecdh.publicKey, sign.publicKey);
}

/** Копия личных ключей, зашифрованная ключом из пароля — хранится на сервере для входа с других устройств */
export async function sealIdentity(id, backupKey) {
  const iv = rand(12);
  const data = te.encode(JSON.stringify({
    ecdh: await subtle.exportKey('jwk', id.ecdhPriv),
    sign: await subtle.exportKey('jwk', id.signPriv),
  }));
  return { v: 1, iv: toB64(iv), ct: toB64(await subtle.encrypt({ name: 'AES-GCM', iv }, backupKey, data)) };
}

/** Бросает исключение, если пароль не тот */
export async function openIdentity(backup, backupKey) {
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(backup.iv) }, backupKey, fromB64(backup.ct));
  const j = JSON.parse(td.decode(plain));
  const pub = k => ({ kty: k.kty, crv: k.crv, x: k.x, y: k.y, ext: true });
  return describeIdentity(
    await subtle.importKey('jwk', j.ecdh, ECDH, true, ['deriveBits']),
    await subtle.importKey('jwk', j.sign, ECDSA, true, ['sign']),
    await subtle.importKey('jwk', pub(j.ecdh), ECDH, true, []),
    await subtle.importKey('jwk', pub(j.sign), ECDSA, true, ['verify']));
}

/** Всё, что нужно серверу при регистрации/переходе: auth, соль и ключи */
export async function newAccountBundle(password) {
  const salt = newSalt();
  const { auth, backupKey } = await deriveFromPassword(password, salt, KDF_ITERS);
  const id = await generateIdentity();
  return { id, auth, salt, iters: KDF_ITERS, keys: { ke: id.ke, ks: id.ks, backup: await sealIdentity(id, backupKey) } };
}

/* ============================================================ хранилище в браузере */

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('tabchat-e2e', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('identity');
      r.result.createObjectStore('peers');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbDo(store, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export const saveIdentity = (uid, id) => idbDo('identity', 'readwrite', st => st.put(id, uid)).catch(() => {});
export const loadIdentity = uid => idbDo('identity', 'readonly', st => st.get(uid)).catch(() => null);
export const forgetIdentity = uid => idbDo('identity', 'readwrite', st => st.delete(uid)).catch(() => {});

/* ============================================================ текущий пользователь */

let ID = null;
let readyResolve;
let ready = new Promise(r => { readyResolve = r; });

export function setIdentity(id) {
  ID = id;
  if (S.me) putUser({ id: S.me.id, ke: id.ke, ks: id.ks });
  readyResolve(id);
}

export const identity = () => ID;
export const whenReady = () => ready;

export function resetIdentity() {
  ID = null;
  ready = new Promise(r => { readyResolve = r; });
  chatKeys.clear();
  peerCache.clear();
}

/* ============================================================ открытые ключи собеседников */

const peerCache = new Map();   // uid -> {ke, ks, ecdh, sign}

export async function peerKeys(uid) {
  let u = S.users.get(uid);
  if (!u || !u.ke || !u.ks) {
    try {
      const [k] = await S.sock.call('users.keys', { ids: [uid] });
      if (k && k.ke) u = putUser({ id: uid, ke: k.ke, ks: k.ks });
    } catch (e) { /* нет сети — попробуем позже */ }
  }
  if (!u || !u.ke || !u.ks) return null;
  // свои ключи знаем сами; чужие — только закреплённые при первой встрече (см. pinnedKeys)
  const use = S.me && uid === S.me.id && ID ? { ke: ID.ke, ks: ID.ks }
    : S.me && uid !== S.me.id ? await pinnedKeys(uid, u) : { ke: u.ke, ks: u.ks };
  const cached = peerCache.get(uid);
  if (cached && cached.ke === use.ke && cached.ks === use.ks && cached.changed === !!use.pending) return cached;
  const entry = {
    ke: use.ke, ks: use.ks, changed: !!use.pending,
    ecdh: await subtle.importKey('raw', fromB64(use.ke), ECDH, false, []),
    sign: await subtle.importKey('raw', fromB64(use.ks), ECDSA, false, ['verify']),
  };
  peerCache.set(uid, entry);
  return entry;
}

/* ============================================================ ключи чатов */

const chatKeys = new Map();   // chatId -> {epoch, exists, missing, keys: Map(epoch -> {raw, key}), refreshed}

async function kek(theirPub, chatId, epoch, by, to) {
  const shared = await subtle.deriveBits({ name: 'ECDH', public: theirPub }, ID.ecdhPriv, 256);
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('tabchat/wrap/v1'), info: te.encode(`${chatId}|${epoch}|${by}|${to}`) },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function wrapFor(raw, chatId, epoch, uid) {
  const peer = await peerKeys(uid);
  if (!peer) return null;
  const iv = rand(12);
  const k = await kek(peer.ecdh, chatId, epoch, S.me.id, uid);
  return { v: 1, by: S.me.id, iv: toB64(iv), ct: toB64(await subtle.encrypt({ name: 'AES-GCM', iv }, k, raw)) };
}

async function unwrap(chatId, epoch, w) {
  const sender = await peerKeys(w.by);
  if (!sender) throw new Error('нет ключа отправителя');
  const k = await kek(sender.ecdh, chatId, epoch, w.by, S.me.id);
  const raw = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(w.iv) }, k, fromB64(w.ct)));
  return { raw, key: await aesKey(raw) };
}

/** Ключи чата с сервера (кэшируются; force — перечитать) */
export async function chatState(chatId, force = false) {
  await ready;
  let st = chatKeys.get(chatId);
  if (!st) {
    st = { keys: new Map(), refreshed: 0, loaded: false, loading: null };
    chatKeys.set(chatId, st);
  }
  if (st.loading) return st.loading;             // запрос уже в пути — ждём его
  if (st.loaded && !force) return st;
  st.loading = (async () => {
    const res = await S.sock.call('keys.chat', { chat: chatId });
    st.epoch = res.epoch;
    st.exists = res.exists;
    st.missing = res.missing;
    for (const { epoch, wrapped } of res.mine) {
      if (st.keys.has(epoch)) continue;
      try { st.keys.set(epoch, await unwrap(chatId, epoch, wrapped)); } catch (e) { console.warn('ключ чата не раскрылся', chatId, epoch, e); }
    }
    st.loaded = true;
    st.refreshed = Date.now();
    return st;
  })().finally(() => { st.loading = null; });
  return st.loading;
}

export const forgetChat = chatId => chatKeys.delete(chatId);

async function memberIds(chat) {
  if (chat.type === 'saved') return [S.me.id];
  if (chat.type === 'dm') return [S.me.id, chat.peer && chat.peer.id].filter(Boolean);
  const list = await S.sock.call('chats.members', { id: chat.id });
  list.forEach(m => putUser(m.user));
  return list.map(m => m.user.id);
}

/** Ключ текущей эпохи для отправки; при необходимости создаёт его или начинает новую эпоху */
export async function keyForSend(chat) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const st = await chatState(chat.id, attempt > 0);
    const have = st.keys.get(st.epoch);
    if (have) return { epoch: st.epoch, key: have.key };
    if (!st.exists) {
      const raw = rand(32);
      const keys = [];
      for (const uid of await memberIds(chat)) {
        const w = await wrapFor(raw, chat.id, st.epoch, uid);
        if (w) keys.push({ epoch: st.epoch, user: uid, wrapped: w });
      }
      const res = await S.sock.call('keys.put', { chat: chat.id, create: true, keys });
      if (res.conflict) continue;              // кто-то создал ключ эпохи раньше — возьмём его
      const entry = { raw, key: await aesKey(raw) };
      st.keys.set(st.epoch, entry);
      st.exists = true;
      return { epoch: st.epoch, key: entry.key };
    }
    // ключ эпохи у других есть, а мне его ещё не передали — начинаем новую эпоху
    await S.sock.call('keys.rotate', { chat: chat.id, from: st.epoch });
  }
  throw new Error('Не удалось получить ключ шифрования чата');
}

/** Передать известные мне ключи чата тем участникам, у кого их ещё нет (новички, только что включившие шифрование) */
export async function heal(chatId) {
  const st = await chatState(chatId, true);
  const keys = [];
  for (const { epoch, users } of st.missing || []) {
    const k = st.keys.get(epoch);
    if (!k) continue;
    for (const uid of users) {
      const w = await wrapFor(k.raw, chatId, epoch, uid);
      if (w) keys.push({ epoch, user: uid, wrapped: w });
    }
  }
  if (keys.length) await S.sock.call('keys.put', { chat: chatId, keys });
  return keys.length;
}

/* ============================================================ сообщения */

const aadOf = r => te.encode(`tabchat/msg/v1|${r.chat}|${r.tab}|${r.epoch}|${r.user}|${r.kind}`);

/** Шифрует полезную нагрузку сообщения {t, f?} для вкладки чата → {epoch, enc} */
export async function encryptPayload(chat, tabId, kind, payload) {
  await ready;
  const { epoch, key } = await keyForSend(chat);
  const iv = rand(12);
  const aad = aadOf({ chat: chat.id, tab: tabId, epoch, user: S.me.id, kind });
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, te.encode(JSON.stringify(payload))));
  const sig = await subtle.sign(SIGN, ID.signPriv, concat(aad, iv, ct));
  return { epoch, enc: { iv: toB64(iv), ct: toB64(ct), sig: toB64(sig) } };
}

function fileMeta(f) {
  if (!f) return {};
  return { mime: f.mime, name: f.name, size: f.size, width: f.w, height: f.h, duration: f.d, waveform: f.wf, key: f.k, iv: f.iv };
}

/** Обратно: описание файла из расшифрованного сообщения → в нагрузку (при правке подписи) */
export function fileToPayload(meta = {}) {
  return { k: meta.key, iv: meta.iv, mime: meta.mime, name: meta.name, size: meta.size,
           w: meta.width, h: meta.height, d: meta.duration, wf: meta.waveform };
}

/** Расшифровывает сообщение (или превью ответа) на месте: text, meta, e2e = ok | nokey | bad */
const seenSigs = new Map();   // подпись → id сообщения

export async function decryptRecord(r) {
  if (!r || !r.enc || r.e2e === 'ok') return r;
  await ready;
  if (r.cipher == null) r.cipher = r.text;
  try {
    if (!r.cipher) throw new Error('пусто');
    const box = JSON.parse(r.cipher);
    let st = await chatState(r.chat);
    let k = st.keys.get(r.epoch);
    if (!k && Date.now() - st.refreshed > 3000) {
      st = await chatState(r.chat, true);
      k = st.keys.get(r.epoch);
    }
    if (!k) { r.e2e = 'nokey'; r.text = ''; return r; }
    const aad = aadOf(r);
    const iv = fromB64(box.iv), ct = fromB64(box.ct);
    const sender = r.user ? await peerKeys(r.user) : null;
    const signed = sender && await subtle.verify(SIGN, sender.sign, fromB64(box.sig), concat(aad, iv, ct));
    if (!signed) { r.e2e = sender && sender.changed ? 'changed' : 'bad'; r.text = ''; return r; }
    // сервер не может «повторить» старое сообщение под новым номером: одна подпись — одно сообщение
    const seen = seenSigs.get(box.sig);
    if (r.id != null && seen != null && seen !== r.id) { r.e2e = 'bad'; r.text = ''; return r; }
    if (r.id != null) seenSigs.set(box.sig, r.id);
    const p = JSON.parse(td.decode(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, k.key, ct)));
    r.text = typeof p.t === 'string' ? p.t : '';
    r.meta = fileMeta(p.f);
    r.fw = p.fw && typeof p.fw.n === 'string' ? { n: p.fw.n.slice(0, 64) } : null;
    r.poll = p.poll && typeof p.poll.q === 'string' && Array.isArray(p.poll.o)
      ? { q: p.poll.q.slice(0, 200), o: p.poll.o.slice(0, 10).map(x => String(x).slice(0, 100)) } : null;
    r.e2e = 'ok';
  } catch (e) {
    r.e2e = 'bad';
    r.text = '';
  }
  return r;
}

export async function decryptMessage(m) {
  await decryptRecord(m);
  if (m && m.reply && m.reply.enc) {
    m.reply.chat = m.reply.chat || m.chat;
    await decryptRecord(m.reply);
  }
  return m;
}

/* ============================================================ файлы */

export async function encryptFile(blob) {
  const raw = rand(32), iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(raw, ['encrypt']), await blob.arrayBuffer());
  return { blob: new Blob([ct], { type: 'application/octet-stream' }), key: toB64(raw), iv: toB64(iv) };
}

const mediaCache = new Map();   // mediaId -> Promise<objectURL>

/** URL для <img>/<audio>/<video>: для зашифрованных — скачать, расшифровать, отдать blob: */
export function mediaSrc(m) {
  if (!m.enc) return Promise.resolve(`/media/${m.media}`);
  if (m.e2e !== 'ok') return Promise.reject(new Error('Файл не расшифрован'));
  // старый незашифрованный файл, к которому позже дописали зашифрованную подпись
  if (!m.meta || !m.meta.key) return Promise.resolve(`/media/${m.media}`);
  if (mediaCache.has(m.media)) return mediaCache.get(m.media);
  const p = (async () => {
    const res = await fetch(`/media/${m.media}`);
    if (!res.ok) throw new Error('Файл не найден');
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(m.meta.iv) }, await aesKey(fromB64(m.meta.key), ['decrypt']), await res.arrayBuffer());
    return URL.createObjectURL(new Blob([plain], { type: m.meta.mime || 'application/octet-stream' }));
  })();
  mediaCache.set(m.media, p);
  p.catch(() => mediaCache.delete(m.media));
  return p;
}

/* ============================================================ коды безопасности */

const EMOJI = ('🐶 🐱 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🦀 🐠 🐬 🐳 🌵 ' +
  '🌲 🍀 🍁 🍄 🌸 🌻 🌙 ⭐ ⚡ 🔥 🌈 ❄️ 🍎 🍋 🍉 🍇 🍓 🍒 🥕 🌽 🍕 🍩 🎈 🎁 🎸 🎲 🚀 ⚓ 🔑 🔔 💎 🎩').split(' ');

async function digest(...parts) {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts)));
}

const keyFingerprint = k => digest(fromB64(k.ks), fromB64(k.ke));

/** Код безопасности пары: одинаковый у обоих собеседников, если ключи никто не подменил */
export async function safetyCode(a, b) {
  const [fa, fb] = await Promise.all([keyFingerprint(a), keyFingerprint(b)]);
  const [x, y] = toB64(fa) < toB64(fb) ? [fa, fb] : [fb, fa];
  const h = await digest(te.encode('tabchat/safety/v1'), x, y);
  const emoji = Array.from({ length: 8 }, (_, i) => EMOJI[h[i] % 64]);
  const groups = Array.from({ length: 12 }, (_, i) => String(((h[8 + 2 * i] << 8) | h[9 + 2 * i]) % 100000).padStart(5, '0'));
  return { emoji, digits: groups.join(' ') };
}

/** Короткий отпечаток своего ключа — для экрана настроек */
export async function myFingerprint() {
  await ready;
  const h = await keyFingerprint(ID);
  return Array.from({ length: 6 }, (_, i) => EMOJI[h[i] % 64]).join(' ');
}

/* ---------- «доверие при первой встрече»: запоминаем ключи собеседников ---------- */

const trustKey = uid => `${S.me.id}:${uid}`;

/**
 * Ключи собеседника закрепляются при первой встрече (TOFU). Законно они не меняются никогда: на новом
 * устройстве ключи восстанавливаются из копии, зашифрованной паролем. Если сервер выдаёт другие ключи,
 * мы их НЕ используем — иначе сервер мог бы подменить ключ, получить от нас ключи чатов и писать от чужого
 * имени. Новый ключ ждёт в pending, пока пользователь не сверит код безопасности и не примет его.
 */
async function pinnedKeys(uid, u) {
  let known;
  try { known = await idbDo('peers', 'readonly', st => st.get(trustKey(uid))); } catch (e) { return { ke: u.ke, ks: u.ks }; }
  if (!known) {
    await idbDo('peers', 'readwrite', st => st.put({ ke: u.ke, ks: u.ks, verified: false, changed: false }, trustKey(uid))).catch(() => {});
    return { ke: u.ke, ks: u.ks };
  }
  if (known.ke === u.ke && known.ks === u.ks) return known;
  if (!known.pending || known.pending.ke !== u.ke || known.pending.ks !== u.ks) {
    const next = { ...known, verified: false, changed: true, pending: { ke: u.ke, ks: u.ks } };
    await idbDo('peers', 'readwrite', st => st.put(next, trustKey(uid))).catch(() => {});
    emit('key_changed', uid);
    return next;
  }
  return known;
}

export async function trustOf(uid) {
  try { return (await idbDo('peers', 'readonly', st => st.get(trustKey(uid)))) || null; } catch (e) { return null; }
}

/** «Коды совпадают»: если ключ менялся — принимаем новый, сверенный при встрече */
export async function setVerified(uid, verified) {
  const known = await trustOf(uid);
  if (!known) { await peerKeys(uid); return setVerified(uid, verified); }
  const next = verified && known.pending
    ? { ke: known.pending.ke, ks: known.pending.ks, verified: true, changed: false }
    : { ...known, verified };
  await idbDo('peers', 'readwrite', st => st.put(next, trustKey(uid)));
  peerCache.delete(uid);
  emit('key_changed', uid);
}

/** Ключи для кода безопасности: новые (ещё не принятые), если сервер их сменил, иначе закреплённые */
export async function safetyKeysOf(uid) {
  const known = await trustOf(uid);
  if (known && known.pending) return known.pending;
  return peerKeys(uid);
}

/* ============================================================ звонки */

const fingerprints = sdp => (sdp.match(/^a=fingerprint:.+$/gm) || []).map(s => s.trim().toLowerCase()).sort().join(',');
const callMessage = (from, to, desc) => te.encode(`tabchat/call/v1|${from}|${to}|${desc.type}|${fingerprints(desc.sdp)}`);

/** Подпись DTLS-отпечатков: подменить их через сервер, не подделав подпись, нельзя */
export async function signCall(fromConn, toConn, desc) {
  await ready;
  return toB64(await subtle.sign(SIGN, ID.signPriv, callMessage(fromConn, toConn, desc)));
}

export async function verifyCall(uid, fromConn, toConn, desc, sig) {
  if (!sig || !uid) return false;
  const peer = await peerKeys(uid);
  if (!peer) return false;
  try { return await subtle.verify(SIGN, peer.sign, fromB64(sig), callMessage(fromConn, toConn, desc)); } catch (e) { return false; }
}

/** 4 эмодзи из отпечатков обеих сторон — у собеседников должны совпасть */
export async function callCode(localSdp, remoteSdp) {
  const a = fingerprints(localSdp), b = fingerprints(remoteSdp);
  const [x, y] = a < b ? [a, b] : [b, a];
  const h = await digest(te.encode(`tabchat/callcode/v1|${x}|${y}`));
  return Array.from({ length: 4 }, (_, i) => EMOJI[h[i] % 64]);
}
