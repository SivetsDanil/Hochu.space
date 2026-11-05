"""Хаб реального времени: WebSocket-подключения, RPC-методы, события, голосовые комнаты.

Протокол:
  клиент → сервер   {"id": n, "m": "method.name", "p": {...}}
  ответ             {"id": n, "ok": result} | {"id": n, "err": "текст ошибки"}
  событие           {"ev": "name", "d": {...}}
"""
import asyncio
import base64
import hashlib
import hmac
import json
import math
import re
import secrets
import time
import traceback
from collections import OrderedDict, defaultdict
from urllib.parse import urlencode

import aiohttp

from . import security

USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{2,31}$")
THEME_RE = re.compile(r"^[a-z0-9-]{1,24}$")
REACTIONS = {"👍", "❤️", "😂", "😮", "😢", "🔥", "👏", "🎉", "🤔", "👎"}
MESSAGE_KINDS = {"text", "image", "file", "voice", "video_note", "poll"}
COLORS = ["#e17076", "#faa774", "#e5ca77", "#7bc862", "#6ec9cb", "#65aadd",
          "#7d8de3", "#a695e7", "#ee7aae", "#f2994a", "#4fc1a6", "#5fa8e8"]
MAX_TEXT = 4000
REJECT_COOLDOWN = 12 * 3600                # после отказа новую заявку в ту же группу можно подать через 12 часов
# Поиск адресов — Nominatim (OpenStreetMap). Его правила: не чаще раза в секунду, свой User-Agent,
# кэш ответов и никакого автодополнения — поэтому запросы идут через сервер и только по нажатию «Найти».
GEO_URL = "https://nominatim.openstreetmap.org/"
GEO_UA = "TabChat/1.0 (self-hosted messenger)"

HANDLERS = {}


def rpc(name):
    def deco(fn):
        HANDLERS[name] = fn
        return fn
    return deco


class RpcError(Exception):
    pass


def clean_line(value, maxlen):
    return " ".join(str(value or "").split())[:maxlen]


def clean_text(value, maxlen=MAX_TEXT):
    return str(value or "").strip()[:maxlen]


def as_coord(value, limit):
    try:
        f = float(value)
    except (TypeError, ValueError):
        raise RpcError("Некорректные координаты")
    if not math.isfinite(f) or abs(f) > limit:
        raise RpcError("Некорректные координаты")
    return round(f, 6)


def short_place(x):
    """Ответ Nominatim → короткая подпись: «Название, улица, дом, город» вместо адреса на три строки."""
    a = x.get("address") or {}
    street = next((a[k] for k in ("road", "pedestrian", "footway", "square", "street") if a.get(k)), None)
    if street and a.get("house_number"):
        street += ", " + a["house_number"]
    city = next((a[k] for k in ("city", "town", "village", "hamlet", "municipality", "county", "state") if a.get(k)), None)
    parts = []
    for v in (x.get("name"), street, city):
        if v and v not in parts:
            parts.append(v)
    full = str(x.get("display_name") or "")
    label = ", ".join(parts) or ", ".join(full.split(", ")[:3])
    return {"label": label[:200], "full": full[:300], "lat": float(x["lat"]), "lon": float(x["lon"])}


def as_int(value, what="id"):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise RpcError("Некорректный %s" % what)


def validate_username(username):
    username = str(username or "").strip().lstrip("@")
    if not USERNAME_RE.match(username):
        raise RpcError("Имя пользователя: 3–32 символа, латиница, цифры и _, начинается с буквы")
    return username


def video_kind(value):
    """Что участник показывает в голосе: камера, экран или ничего."""
    return value if value in ("camera", "screen") else None


def validate_name(name):
    name = clean_line(name, 64)
    if not name:
        raise RpcError("Укажите имя")
    return name


# ---------------- проверка криптографических полей ----------------
# Сервер не может (и не должен) проверить содержимое шифротекста — только форму и размеры.
B64_RE = re.compile(r"^[A-Za-z0-9+/_-]*={0,2}$")
KDF_MIN_ITERS, KDF_MAX_ITERS = 100_000, 5_000_000


def b64(value, what, min_len=1, max_len=100_000):
    if not isinstance(value, str) or not (min_len <= len(value) <= max_len) or not B64_RE.match(value):
        raise RpcError("Некорректное поле шифрования: %s" % what)
    return value


def validate_auth(value):
    """auth — ключ, выведенный из пароля в браузере (сам пароль на сервер не попадает)."""
    if not isinstance(value, str) or not re.match(r"^[0-9a-f]{64}$", value):
        raise RpcError("Некорректные данные входа — обновите страницу")
    return value


def validate_kdf(salt, iters):
    b64(salt, "соль", 16, 64)
    try:
        iters = int(iters)
    except (TypeError, ValueError):
        raise RpcError("Некорректные параметры пароля")
    if not KDF_MIN_ITERS <= iters <= KDF_MAX_ITERS:
        raise RpcError("Некорректные параметры пароля")
    return salt, iters


def validate_sealed(value, what, max_len=16_000):
    """Зашифрованный блок {v, iv, ct} — резервная копия ключей."""
    if not isinstance(value, dict):
        raise RpcError("Некорректное поле шифрования: %s" % what)
    b64(value.get("iv"), what, 12, 32)
    b64(value.get("ct"), what, 16, max_len)
    return json.dumps({"v": 1, "iv": value["iv"], "ct": value["ct"]}, separators=(",", ":"))


def validate_identity(keys):
    """Открытые ключи пользователя + зашифрованная паролем копия закрытых."""
    if not isinstance(keys, dict):
        raise RpcError("Нет ключей шифрования — обновите страницу")
    return {
        "key_ecdh": b64(keys.get("ke"), "ключ обмена", 80, 100),
        "key_sign": b64(keys.get("ks"), "ключ подписи", 80, 100),
        "key_backup": validate_sealed(keys.get("backup"), "резервная копия ключей"),
    }


def validate_enc_payload(enc):
    """Шифротекст сообщения: iv + ct + подпись отправителя."""
    if not isinstance(enc, dict):
        raise RpcError("Сообщение должно быть зашифровано — обновите страницу")
    return json.dumps({"v": 1, "iv": b64(enc.get("iv"), "iv", 12, 32), "ct": b64(enc.get("ct"), "текст", 16, 96_000),
                       "sig": b64(enc.get("sig"), "подпись", 40, 200)}, separators=(",", ":"))


def validate_wrapped(value, by_user):
    """Ключ чата, зашифрованный для одного участника."""
    if not isinstance(value, dict) or value.get("by") != by_user:
        raise RpcError("Некорректный ключ чата")
    return json.dumps({"v": 1, "by": by_user, "iv": b64(value.get("iv"), "iv", 12, 32),
                       "ct": b64(value.get("ct"), "ключ", 40, 200)}, separators=(",", ":"))


class Conn:
    def __init__(self, ws, uid, token_hash):
        self.id = secrets.token_hex(6)
        self.ws = ws
        self.uid = uid
        self.token_hash = token_hash
        self.voice = None  # id голосовой вкладки

    async def send(self, obj):
        if self.ws.closed:
            return
        try:
            await self.ws.send_str(json.dumps(obj, ensure_ascii=False))
        except Exception:
            pass


class Hub:
    def __init__(self, db):
        self.db = db
        self.conns = {}                    # conn_id -> Conn
        self.by_user = defaultdict(set)    # user_id -> {conn_id}
        self.rooms = {}                    # tab_id -> {"chat": chat_id, "parts": {conn_id: {...}}}
        self.public_url = None             # адрес в интернете, если поднят туннель
        self.tunnel_kind = None            # free | temp | relay
        self.lan_urls = []                 # https-адреса в локальной сети
        self.turn = None                   # {"urls": [...], "secret": "..."} от relay — для звонков через интернет
        self.server_id = None              # постоянный id сервера (см. web.make_app)
        self.client_app = None             # {"size": байты}, если рядом лежит TabChat.exe для скачивания
        self.geo_http = None               # HTTP-клиент для поиска адресов (создаётся при первом поиске)
        self.geo_lock = asyncio.Lock()
        self.geo_last = 0.0
        self.geo_cache = OrderedDict()

    async def close(self):
        if self.geo_http:
            await self.geo_http.close()

    # ================= адреса и TURN =================
    async def set_public(self, url, turn, kind=None):
        """kind: 'free' — бесплатный постоянный адрес (srv.us), 'temp' — запасной, меняется при подключении
        (localhost.run), 'relay' — свой сервер."""
        if (url, turn, kind) == (self.public_url, self.turn, self.tunnel_kind):
            return
        self.public_url, self.turn, self.tunnel_kind = url, turn, (kind if url else None)
        for conn in list(self.conns.values()):
            await conn.send({"ev": "server", "d": self.server_info(conn.uid)})

    def ice_servers(self, uid):
        """Временные логин/пароль для TURN (схема coturn use-auth-secret), сутки жизни."""
        if not self.turn:
            return []
        username = "%d:%d" % (int(time.time()) + 86400, uid)
        digest = hmac.new(self.turn["secret"].encode(), username.encode(), hashlib.sha1).digest()
        return [{"urls": self.turn["urls"], "username": username, "credential": base64.b64encode(digest).decode()}]

    def server_info(self, uid):
        return {"public_url": self.public_url, "tunnel": self.tunnel_kind, "lan_urls": self.lan_urls,
                "ice": self.ice_servers(uid), "client_app": self.client_app}

    # ================= сериализация =================
    def pub(self, row):
        if row is None:
            return None
        return {
            "id": row["id"], "username": row["username"], "name": row["name"], "color": row["color"],
            "avatar": row["avatar"], "bio": row["bio"], "online": row["id"] in self.by_user,
            "last_seen": row["last_seen"],
            # открытые ключи для сквозного шифрования (None — аккаунт ещё не включил шифрование)
            "ke": row["key_ecdh"], "ks": row["key_sign"],
        }

    def pub_id(self, uid):
        return self.pub(self.db.user(uid)) if uid else None

    def reply_preview(self, mid):
        r = self.db.message(mid)
        if not r:
            return {"id": mid, "deleted": True}
        out = {"id": r["id"], "user": r["user_id"], "kind": r["kind"]}
        if r["enc"]:
            # сервер не может сделать превью шифротекста — отдаём его клиенту целиком, тот расшифрует сам
            out.update(enc=1, chat=r["chat_id"], tab=r["tab_id"], epoch=r["epoch"],
                       text=r["text"] if len(r["text"]) <= 12000 else "")
        else:
            out["text"] = r["text"][:160]
        return out

    def ser_message(self, r, reactions=None):
        out = {
            "id": r["id"], "chat": r["chat_id"], "tab": r["tab_id"], "user": r["user_id"], "kind": r["kind"],
            "text": r["text"], "media": r["media"], "meta": json.loads(r["meta"]) if r["meta"] else {},
            "reply_to": r["reply_to"], "reply": self.reply_preview(r["reply_to"]) if r["reply_to"] else None,
            "ts": r["created_at"], "edited": r["edited_at"], "enc": r["enc"], "epoch": r["epoch"],
            "reactions": reactions if reactions is not None else self.db.reactions([r["id"]]).get(r["id"], []),
        }
        if r["kind"] == "poll":
            # вопрос и варианты зашифрованы; сервер видит только, кто выбрал какой по счёту вариант
            out["votes"] = self.db.poll_votes(r["id"])
        return out

    def ser_chat(self, c, uid):
        db = self.db
        cid = c["id"]
        m = db.member(cid, uid)
        tabs = []
        for t in db.tabs(cid):
            d = {"id": t["id"], "name": t["name"], "kind": t["kind"], "position": t["position"], "pinned": t["pinned"]}
            if t["kind"] == "text":
                lr = db.last_read(t["id"], uid)
                d.update(read=lr, unread=db.unread_count(t["id"], uid, lr), others_read=db.others_read(t["id"], uid))
            tabs.append(d)
        out = {
            "id": cid, "type": c["type"], "title": c["title"], "about": c["about"], "avatar": c["avatar"], "emoji": c["emoji"],
            "color": c["color"], "owner": c["owner_id"], "created": c["created_at"],
            "role": m["role"] if m else None, "muted": bool(m["muted"]) if m else False,
            "theme": c["theme"], "my_theme": m["theme"] if m else None,
            "members": db.member_count(cid), "tabs": tabs, "last": None, "last_author": None,
        }
        if c["type"] == "group":
            out["invite"] = c["invite"]
            pl = db.place(cid)
            out["place"] = {"lat": pl["lat"], "lon": pl["lon"], "address": pl["address"]} if pl else None
            if m and m["role"] in ("owner", "admin"):
                out["requests"] = db.pending_requests(cid)
        if c["type"] == "dm":
            out["peer"] = self.pub_id(db.dm_peer(cid, uid))
        if c["last_msg_id"]:
            lm = db.message(c["last_msg_id"])
            if lm:
                out["last"] = self.ser_message(lm, reactions=[])
                out["last_author"] = self.pub_id(lm["user_id"])
        return out

    def voice_parts(self, tid):
        room = self.rooms.get(tid)
        if not room:
            return []
        return [dict(conn=cid, **{k: v for k, v in p.items()}, u=self.pub_id(p["user"]))
                for cid, p in room["parts"].items()]

    # ================= доставка событий =================
    async def push_user(self, uid, ev, data, exclude_conn=None):
        msg = {"ev": ev, "d": data}
        for cid in list(self.by_user.get(uid, ())):
            if cid != exclude_conn and cid in self.conns:
                await self.conns[cid].send(msg)

    async def push_users(self, uids, ev, data, exclude_user=None):
        for uid in uids:
            if uid != exclude_user:
                await self.push_user(uid, ev, data)

    async def push_chat(self, cid, ev, data, exclude_user=None):
        await self.push_users(self.db.member_ids(cid), ev, data, exclude_user)

    async def push_chat_state(self, cid, uids=None):
        """Каждому участнику — его версия чата (непрочитанные у всех свои)."""
        c = self.db.chat(cid)
        if not c:
            return
        for uid in (uids if uids is not None else self.db.member_ids(cid)):
            if uid in self.by_user:
                await self.push_user(uid, "chat", {"chat": self.ser_chat(c, uid)})

    async def system_message(self, cid, actor, text):
        tid = self.db.first_text_tab(cid)
        if not tid:
            return
        mid = self.db.add_message(cid, tid, actor, "system", text)
        await self.push_chat(cid, "message", {"message": self.ser_message(self.db.message(mid), []),
                                              "author": self.pub_id(actor)})

    # ================= подключения =================
    async def connect(self, conn):
        first = conn.uid not in self.by_user
        self.conns[conn.id] = conn
        self.by_user[conn.uid].add(conn.id)
        self.db.touch_session(conn.token_hash)
        if first:
            await self.push_presence(conn.uid)

    async def disconnect(self, conn):
        await self.voice_leave(conn)
        self.conns.pop(conn.id, None)
        conns = self.by_user.get(conn.uid)
        if conns is not None:
            conns.discard(conn.id)
            if not conns:
                del self.by_user[conn.uid]
                self.db.update_user(conn.uid, last_seen=time.time())
                await self.push_presence(conn.uid)

    async def push_presence(self, uid):
        u = self.db.user(uid)
        if not u:
            return
        data = {"user": uid, "online": uid in self.by_user, "last_seen": u["last_seen"]}
        await self.push_users(self.db.co_member_ids(uid), "presence", data)

    async def close_session(self, token_hash):
        for conn in [c for c in self.conns.values() if c.token_hash == token_hash]:
            await conn.ws.close(code=4001, message=b"session revoked")

    async def dispatch(self, conn, msg):
        rid = msg.get("id")
        fn = HANDLERS.get(msg.get("m"))
        params = msg.get("p") or {}
        try:
            if fn is None:
                raise RpcError("Неизвестный метод")
            if not isinstance(params, dict):
                raise RpcError("Некорректные параметры")
            result = await fn(self, conn, params)
            if rid is not None:
                await conn.send({"id": rid, "ok": result if result is not None else True})
        except RpcError as e:
            if rid is not None:
                await conn.send({"id": rid, "err": str(e)})
        except Exception:
            traceback.print_exc()
            if rid is not None:
                await conn.send({"id": rid, "err": "Ошибка сервера"})

    # ================= проверки доступа =================
    def need_member(self, cid, uid):
        m = self.db.member(cid, uid)
        if not m:
            raise RpcError("Нет доступа к чату")
        return m

    def need_chat(self, cid, uid):
        c = self.db.chat(as_int(cid))
        if not c:
            raise RpcError("Чат не найден")
        return c, self.need_member(c["id"], uid)

    def need_admin(self, cid, uid):
        c, m = self.need_chat(cid, uid)
        if c["type"] != "group" or m["role"] not in ("owner", "admin"):
            raise RpcError("Нужны права администратора")
        return c, m

    def need_tab(self, tid, uid):
        t = self.db.tab(as_int(tid))
        if not t:
            raise RpcError("Вкладка не найдена")
        return t, self.need_member(t["chat_id"], uid)

    # ================= синхронизация, пользователи, профиль =================
    @rpc("sync")
    async def h_sync(self, conn, p):
        uid = conn.uid
        chats = [self.ser_chat(c, uid) for c in self.db.user_chats(uid)]
        chat_ids = {c["id"] for c in chats}
        voice = {str(tid): self.voice_parts(tid) for tid, room in self.rooms.items() if room["chat"] in chat_ids}
        return {"me": self.pub_id(uid), "conn": conn.id, "chats": chats, "voice": voice,
                "server": self.server_info(uid)}

    @rpc("users.search")
    async def h_users_search(self, conn, p):
        q = clean_line(p.get("q"), 64).lstrip("@")
        if not q:
            return []
        return [self.pub(u) for u in self.db.search_users(q)]

    @rpc("users.get")
    async def h_users_get(self, conn, p):
        if p.get("username"):
            u = self.db.user_by_username(str(p["username"]).lstrip("@"))
        else:
            u = self.db.user(as_int(p.get("id")))
        if not u:
            raise RpcError("Пользователь не найден")
        return self.pub(u)

    @rpc("profile.update")
    async def h_profile_update(self, conn, p):
        fields = {}
        if "name" in p:
            fields["name"] = validate_name(p["name"])
        if "bio" in p:
            fields["bio"] = clean_text(p["bio"], 200)
        if "color" in p and p["color"] in COLORS:
            fields["color"] = p["color"]
        if "username" in p:
            username = validate_username(p["username"])
            other = self.db.user_by_username(username)
            if other and other["id"] != conn.uid:
                raise RpcError("Этот @username уже занят")
            fields["username"] = username
        if "avatar" in p:
            fields["avatar"] = self.own_media(conn.uid, p["avatar"], image=True) if p["avatar"] else None
        self.db.update_user(conn.uid, **fields)
        user = self.pub_id(conn.uid)
        await self.push_users(self.db.co_member_ids(conn.uid) | {conn.uid}, "user", {"user": user})
        return user

    @staticmethod
    async def check_secret(secret, pw_hash):
        return await asyncio.get_running_loop().run_in_executor(None, security.check_password, secret, pw_hash)

    @staticmethod
    async def hash_secret(secret):
        return await asyncio.get_running_loop().run_in_executor(None, security.hash_password, secret)

    @rpc("auth.password")
    async def h_password(self, conn, p):
        """Смена пароля: браузер присылает ключи, выведенные из старого и нового пароля, и заново
        зашифрованную копию ключей. Сам пароль сервер не видит."""
        u = self.db.user(conn.uid)
        if u["kdf"] != "v1":
            raise RpcError("Сначала включите шифрование — обновите страницу")
        if not await self.check_secret(validate_auth(p.get("old_auth")), u["pw_hash"]):
            raise RpcError("Текущий пароль указан неверно")
        salt, iters = validate_kdf(p.get("salt"), p.get("iters"))
        backup = validate_sealed(p.get("backup"), "резервная копия ключей")
        pw_hash = await self.hash_secret(validate_auth(p.get("auth")))
        self.db.update_user(conn.uid, pw_hash=pw_hash, kdf_salt=salt, kdf_iters=iters, key_backup=backup)
        return True

    # ================= сквозное шифрование: ключи =================
    @rpc("keys.info")
    async def h_keys_info(self, conn, p):
        """Параметры пароля и зашифрованная копия ключей — чтобы открыть переписку на этом устройстве."""
        u = self.db.user(conn.uid)
        return {"kdf": u["kdf"], "salt": u["kdf_salt"], "iters": u["kdf_iters"], "has_keys": bool(u["key_ecdh"]),
                "backup": json.loads(u["key_backup"]) if u["key_backup"] else None}

    @rpc("keys.upgrade")
    async def h_keys_upgrade(self, conn, p):
        """Аккаунт со старым входом включает шифрование: в последний раз подтверждает обычным паролем."""
        u = self.db.user(conn.uid)
        if u["kdf"] == "v1":
            raise RpcError("Шифрование уже включено")
        if not await self.check_secret(str(p.get("password") or ""), u["pw_hash"]):
            await asyncio.sleep(0.4)
            raise RpcError("Неверный пароль")
        await self.apply_upgrade(conn.uid, p)
        return True

    async def apply_upgrade(self, uid, p):
        auth = validate_auth(p.get("auth"))
        salt, iters = validate_kdf(p.get("salt"), p.get("iters"))
        keys = validate_identity(p.get("keys"))
        pw_hash = await self.hash_secret(auth)
        self.db.update_user(uid, pw_hash=pw_hash, kdf="v1", kdf_salt=salt, kdf_iters=iters, **keys)
        await self.keys_published(uid)

    async def keys_published(self, uid):
        """У пользователя появились ключи — собеседники обновляют его карточку и могут передать ему ключи чатов."""
        await self.push_users(self.db.co_member_ids(uid), "user", {"user": self.pub_id(uid)})
        for c in self.db.user_chats(uid):
            await self.push_chat(c["id"], "keys_needed", {"chat": c["id"]}, exclude_user=uid)

    @rpc("users.keys")
    async def h_users_keys(self, conn, p):
        ids = [as_int(x) for x in (p.get("ids") or [])[:500]]
        return [{"id": r["id"], "ke": r["key_ecdh"], "ks": r["key_sign"]} for r in self.db.users_keys(ids)]

    @rpc("keys.chat")
    async def h_keys_chat(self, conn, p):
        """Мои ключи этого чата по эпохам + кому из участников ключи ещё не передали."""
        c, _ = self.need_chat(p.get("chat"), conn.uid)
        mine = self.db.chat_keys_of(c["id"], conn.uid)
        missing = self.db.missing_chat_keys(c["id"], [r["epoch"] for r in mine]) if mine else {}
        return {"chat": c["id"], "epoch": c["key_epoch"], "exists": self.db.has_chat_key(c["id"], c["key_epoch"]),
                "mine": [{"epoch": r["epoch"], "wrapped": json.loads(r["wrapped"])} for r in mine],
                "missing": [{"epoch": e, "users": us} for e, us in missing.items()]}

    @rpc("keys.put")
    async def h_keys_put(self, conn, p):
        """create=True — первый ключ текущей эпохи (кто успел первым, того и ключ);
        иначе — передача уже известных отправителю ключей новым участникам."""
        c, _ = self.need_chat(p.get("chat"), conn.uid)
        members = set(self.db.member_ids(c["id"]))
        rows = []
        for item in (p.get("keys") or [])[:2000]:
            if not isinstance(item, dict):
                continue
            uid = as_int(item.get("user"))
            if uid in members:
                rows.append((as_int(item.get("epoch")), uid, validate_wrapped(item.get("wrapped"), conn.uid)))
        if p.get("create"):
            epoch = c["key_epoch"]
            if not rows or any(e != epoch for e, _, _ in rows) or not any(u == conn.uid for _, u, _ in rows):
                raise RpcError("Некорректный набор ключей")
            with self.db.tx():
                if self.db.has_chat_key(c["id"], epoch):
                    return {"conflict": True}
                for e, u, w in rows:
                    self.db.add_chat_key(c["id"], e, u, w, conn.uid)
            added = rows
        else:
            known = {r["epoch"] for r in self.db.chat_keys_of(c["id"], conn.uid)}
            added = []
            with self.db.tx():
                for e, u, w in rows:
                    if e in known and self.db.add_chat_key(c["id"], e, u, w, conn.uid):
                        added.append((e, u, w))
        await self.push_users({u for _, u, _ in added if u != conn.uid}, "keys", {"chat": c["id"]})
        return {"ok": True, "added": len(added)}

    @rpc("keys.rotate")
    async def h_keys_rotate(self, conn, p):
        """У меня нет ключа текущей эпохи, а передать его некому (все офлайн) — начинаем новую эпоху."""
        c, _ = self.need_chat(p.get("chat"), conn.uid)
        epoch = c["key_epoch"]
        if (as_int(p.get("from")) == epoch and self.db.has_chat_key(c["id"], epoch)
                and not self.db.has_chat_key(c["id"], epoch, conn.uid)):
            epoch = self.db.bump_epoch(c["id"])
        return {"epoch": epoch}

    def check_epoch(self, chat_id, epoch, uid):
        c = self.db.chat(chat_id)
        if epoch != c["key_epoch"]:
            raise RpcError("e2e:stale")         # клиент обновит ключи и зашифрует заново
        if not self.db.has_chat_key(chat_id, epoch, uid):
            raise RpcError("e2e:nokey")

    @rpc("sessions.list")
    async def h_sessions(self, conn, p):
        return [{"id": s["token_hash"][:16], "agent": s["agent"], "created": s["created_at"],
                 "active": s["last_active"], "current": s["token_hash"] == conn.token_hash,
                 "online": any(c.token_hash == s["token_hash"] for c in self.conns.values())}
                for s in self.db.sessions(conn.uid)]

    @rpc("sessions.revoke")
    async def h_sessions_revoke(self, conn, p):
        sid = str(p.get("id") or "")
        everyone_else = bool(p.get("others"))
        for s in self.db.sessions(conn.uid):
            th = s["token_hash"]
            if th == conn.token_hash:
                continue
            if everyone_else or (sid and th.startswith(sid)):
                self.db.delete_session(th)
                await self.close_session(th)
        return True

    def own_media(self, uid, media_id, image=False):
        m = self.db.media(str(media_id))
        if not m or m["user_id"] != uid:
            raise RpcError("Файл не найден")
        if image and not m["mime"].startswith("image/"):
            raise RpcError("Нужна картинка")
        return m["id"]

    # ================= чаты =================
    @rpc("chats.get")
    async def h_chat_get(self, conn, p):
        c, _ = self.need_chat(p.get("id"), conn.uid)
        return self.ser_chat(c, conn.uid)

    @rpc("chats.open_dm")
    async def h_open_dm(self, conn, p):
        other = self.db.user(as_int(p.get("user")))
        if not other:
            raise RpcError("Пользователь не найден")
        uid = conn.uid
        if other["id"] == uid:
            c = self.db.chat_by_key("saved:%d" % uid)
            return self.ser_chat(c, uid)
        key = "dm:%d:%d" % (min(uid, other["id"]), max(uid, other["id"]))
        c = self.db.chat_by_key(key)
        if not c:
            with self.db.tx():
                cid = self.db.create_chat("dm", dm_key=key)
                self.db.add_member(cid, uid)
                self.db.add_member(cid, other["id"])
            c = self.db.chat(cid)
        return self.ser_chat(c, uid)

    @rpc("chats.create_group")
    async def h_create_group(self, conn, p):
        title = clean_line(p.get("title"), 64)
        if not title:
            raise RpcError("Укажите название группы")
        ids = {as_int(x) for x in (p.get("members") or [])[:200]}
        ids = {u for u in ids if u != conn.uid and self.db.user(u)}
        with self.db.tx():
            cid = self.db.create_chat("group", title=title, owner=conn.uid, color=COLORS[secrets.randbelow(len(COLORS))])
            self.db.add_member(cid, conn.uid, "owner")
            for u in ids:
                self.db.add_member(cid, u)
        me = self.db.user(conn.uid)
        await self.push_chat_state(cid, uids=list(ids))
        await self.system_message(cid, conn.uid, "%s создал(а) группу «%s»" % (me["name"], title))
        return self.ser_chat(self.db.chat(cid), conn.uid)

    @rpc("chats.update")
    async def h_chat_update(self, conn, p):
        c, _ = self.need_admin(p.get("id"), conn.uid)
        fields = {}
        if "title" in p:
            title = clean_line(p["title"], 64)
            if not title:
                raise RpcError("Название не может быть пустым")
            fields["title"] = title
        if "about" in p:
            fields["about"] = clean_text(p["about"], 300)
        if "avatar" in p:
            fields["avatar"] = self.own_media(conn.uid, p["avatar"], image=True) if p["avatar"] else None
        if "emoji" in p:
            emoji = clean_line(p["emoji"], 16)
            fields["emoji"] = emoji or None
        if "color" in p:
            if p["color"] not in COLORS:
                raise RpcError("Неизвестный цвет")
            fields["color"] = p["color"]
        if fields:
            self.db.update_chat(c["id"], **fields)
        me = self.db.user(conn.uid)
        if "title" in fields and fields["title"] != c["title"]:
            await self.system_message(c["id"], conn.uid, "%s переименовал(а) группу в «%s»" % (me["name"], fields["title"]))
        await self.push_chat_state(c["id"])
        return True

    @rpc("chats.theme")
    async def h_chat_theme(self, conn, p):
        """Оформление чата: для всех (в группе — админы, в личке — любой из двоих) или только для себя."""
        c, m = self.need_chat(p.get("id"), conn.uid)
        theme = str(p.get("theme") or "")
        if theme and not THEME_RE.match(theme):
            raise RpcError("Неизвестная тема")
        if p.get("scope") == "all":
            if c["type"] == "group" and m["role"] not in ("owner", "admin"):
                raise RpcError("Оформление для всех меняют администраторы")
            self.db.update_chat(c["id"], theme=theme or None)
            self.db.set_member_theme(c["id"], conn.uid, None)     # сам увидит то же, что и все
            await self.push_chat_state(c["id"])
        else:
            self.db.set_member_theme(c["id"], conn.uid, theme or None)
            await self.push_chat_state(c["id"], uids=[conn.uid])
        return True

    @rpc("chats.members")
    async def h_members(self, conn, p):
        c, _ = self.need_chat(p.get("id"), conn.uid)
        return [{"user": self.pub_id(m["user_id"]), "role": m["role"], "joined": m["joined_at"]}
                for m in self.db.members(c["id"])]

    @rpc("chats.add_members")
    async def h_add_members(self, conn, p):
        c, _ = self.need_chat(p.get("id"), conn.uid)
        if c["type"] != "group":
            raise RpcError("Добавлять участников можно только в группу")
        me = self.db.user(conn.uid)
        added = []
        for raw in (p.get("users") or [])[:200]:
            u = self.db.user(as_int(raw))
            if u and not self.db.member(c["id"], u["id"]):
                self.db.add_member(c["id"], u["id"])
                added.append(u)
        for u in added:
            await self.system_message(c["id"], conn.uid, "%s добавил(а) %s" % (me["name"], u["name"]))
        if added:
            await self.push_chat_state(c["id"])
            # кто-нибудь из участников в сети передаст новичкам ключ чата
            await self.push_chat(c["id"], "keys_needed", {"chat": c["id"]})
        return len(added)

    @rpc("chats.kick")
    async def h_kick(self, conn, p):
        c, m = self.need_admin(p.get("id"), conn.uid)
        target = self.db.member(c["id"], as_int(p.get("user")))
        if not target or target["user_id"] == conn.uid:
            raise RpcError("Нельзя удалить этого участника")
        if target["role"] == "owner" or (target["role"] == "admin" and m["role"] != "owner"):
            raise RpcError("Недостаточно прав")
        await self.remove_from_chat(c, target["user_id"])
        me = self.db.user(conn.uid)
        victim = self.db.user(target["user_id"])
        await self.system_message(c["id"], conn.uid, "%s удалил(а) %s из группы" % (me["name"], victim["name"]))
        await self.push_chat_state(c["id"])
        return True

    @rpc("chats.set_role")
    async def h_set_role(self, conn, p):
        c, m = self.need_admin(p.get("id"), conn.uid)
        if m["role"] != "owner":
            raise RpcError("Назначать администраторов может только владелец")
        role = p.get("role")
        if role not in ("admin", "member"):
            raise RpcError("Неизвестная роль")
        target = self.db.member(c["id"], as_int(p.get("user")))
        if not target or target["role"] == "owner":
            raise RpcError("Нельзя изменить роль этого участника")
        self.db.set_role(c["id"], target["user_id"], role)
        await self.push_chat_state(c["id"], uids=[target["user_id"]])
        return True

    @rpc("chats.leave")
    async def h_leave(self, conn, p):
        c, m = self.need_chat(p.get("id"), conn.uid)
        if c["type"] != "group":
            raise RpcError("Из личного чата нельзя выйти")
        me = self.db.user(conn.uid)
        await self.remove_from_chat(c, conn.uid)
        rest = self.db.members(c["id"])
        if not rest:
            self.db.delete_chat(c["id"])
            return True
        if m["role"] == "owner":
            heir = next((r for r in rest if r["role"] == "admin"), rest[0])
            self.db.set_role(c["id"], heir["user_id"], "owner")
            self.db.update_chat(c["id"], owner_id=heir["user_id"])
        await self.system_message(c["id"], conn.uid, "%s покинул(а) группу" % me["name"])
        await self.push_chat_state(c["id"])
        return True

    @rpc("chats.delete")
    async def h_delete_chat(self, conn, p):
        c, m = self.need_chat(p.get("id"), conn.uid)
        if c["type"] != "group" or m["role"] != "owner":
            raise RpcError("Удалить группу может только владелец")
        uids = self.db.member_ids(c["id"])
        await self.kick_voice(c["id"])
        self.db.delete_chat(c["id"])
        await self.push_users(uids, "chat_removed", {"chat": c["id"]})
        return True

    async def remove_from_chat(self, c, uid):
        self.db.remove_member(c["id"], uid)
        # новая эпоха ключа: ушедший не сможет читать то, что напишут после него
        self.db.bump_epoch(c["id"])
        await self.kick_voice(c["id"], uid)
        await self.push_user(uid, "chat_removed", {"chat": c["id"]})

    async def kick_voice(self, cid, uid=None):
        for conn in list(self.conns.values()):
            if conn.voice and self.rooms.get(conn.voice, {}).get("chat") == cid and (uid is None or conn.uid == uid):
                await self.voice_leave(conn)
                await conn.send({"ev": "voice_kicked", "d": {"chat": cid}})

    @rpc("chats.mute")
    async def h_mute(self, conn, p):
        c, _ = self.need_chat(p.get("id"), conn.uid)
        self.db.set_muted(c["id"], conn.uid, bool(p.get("muted")))
        await self.push_chat_state(c["id"], uids=[conn.uid])
        return True

    @rpc("chats.reset_invite")
    async def h_reset_invite(self, conn, p):
        c, _ = self.need_admin(p.get("id"), conn.uid)
        self.db.update_chat(c["id"], invite=secrets.token_urlsafe(9))
        await self.push_chat_state(c["id"])
        return True

    @rpc("chats.invite_info")
    async def h_invite_info(self, conn, p):
        c = self.db.chat_by_invite(str(p.get("code") or ""))
        if not c:
            raise RpcError("Ссылка-приглашение недействительна")
        return {"id": c["id"], "title": c["title"], "about": c["about"], "avatar": c["avatar"], "color": c["color"],
                "members": self.db.member_count(c["id"]), "joined": bool(self.db.member(c["id"], conn.uid))}

    @rpc("chats.join")
    async def h_join(self, conn, p):
        c = self.db.chat_by_invite(str(p.get("code") or ""))
        if not c:
            raise RpcError("Ссылка-приглашение недействительна")
        if not self.db.member(c["id"], conn.uid):
            self.db.add_member(c["id"], conn.uid)
            me = self.db.user(conn.uid)
            await self.system_message(c["id"], conn.uid, "%s присоединился(-ась) по ссылке" % me["name"])
            await self.push_chat_state(c["id"])
            await self.push_chat(c["id"], "keys_needed", {"chat": c["id"]}, exclude_user=conn.uid)
        return self.ser_chat(self.db.chat(c["id"]), conn.uid)

    # ================= карта: группы по адресу и заявки на вступление =================
    @staticmethod
    def ser_place(r):
        """Карточка группы на карте. Её видят все пользователи сервера, поэтому в ней только открытое:
        название, описание, аватар, адрес и число участников. Переписка остаётся зашифрованной."""
        req = r["req_status"]
        if req == "rejected" and time.time() - (r["req_decided"] or 0) >= REJECT_COOLDOWN:
            req = None
        return {"chat": r["chat_id"], "title": r["title"], "about": r["about"], "avatar": r["avatar"], "emoji": r["emoji"],
                "color": r["color"], "members": r["members"], "lat": r["lat"], "lon": r["lon"],
                "address": r["address"], "member": bool(r["is_member"]), "request": req}

    @rpc("places.search")
    async def h_places_search(self, conn, p):
        south, north = sorted((as_coord(p.get("south"), 90), as_coord(p.get("north"), 90)))
        west, east = as_coord(p.get("west"), 180), as_coord(p.get("east"), 180)
        return [self.ser_place(r) for r in self.db.places_in(conn.uid, south, west, north, east, 400)]

    @rpc("places.find")
    async def h_places_find(self, conn, p):
        q = clean_line(p.get("q"), 100)
        return [self.ser_place(r) for r in self.db.find_places(conn.uid, q)] if len(q) >= 2 else []

    @rpc("places.get")
    async def h_place_get(self, conn, p):
        r = self.db.place_card(conn.uid, as_int(p.get("chat")))
        if not r:
            raise RpcError("Этой группы нет на карте")
        return self.ser_place(r)

    @rpc("places.set")
    async def h_place_set(self, conn, p):
        c, _ = self.need_admin(p.get("chat"), conn.uid)
        lat, lon = as_coord(p.get("lat"), 85.06), as_coord(p.get("lon"), 180)
        address = clean_line(p.get("address"), 200)
        first = not self.db.place(c["id"])
        self.db.set_place(c["id"], lat, lon, address, conn.uid)
        if first:
            me = self.db.user(conn.uid)
            await self.system_message(c["id"], conn.uid, "%s отметил(а) группу на карте — теперь её видят все и могут "
                                                         "подать заявку на вступление" % me["name"])
        await self.push_chat_state(c["id"])
        return True

    @rpc("places.clear")
    async def h_place_clear(self, conn, p):
        c, _ = self.need_admin(p.get("chat"), conn.uid)
        if self.db.place(c["id"]):
            self.db.clear_place(c["id"])
            me = self.db.user(conn.uid)
            await self.system_message(c["id"], conn.uid, "%s убрал(а) группу с карты" % me["name"])
            await self.push_chat_state(c["id"])
        return True

    async def push_requests(self, c, new_from=None):
        """Админам — новое число заявок, а о новой заявке — отдельное уведомление."""
        admins = self.db.admin_ids(c["id"])
        await self.push_chat_state(c["id"], uids=admins)
        if new_from:
            await self.push_users(admins, "join_request", {"chat": c["id"], "title": c["title"],
                                                           "user": self.pub_id(new_from)})

    @rpc("join.request")
    async def h_join_request(self, conn, p):
        cid = as_int(p.get("chat"))
        c = self.db.chat(cid)
        if not c or c["type"] != "group" or not self.db.place(cid):
            raise RpcError("Этой группы нет на карте")
        if self.db.member(cid, conn.uid):
            raise RpcError("Вы уже в этой группе")
        old = self.db.join_request(cid, conn.uid)
        if old and old["status"] == "pending":
            raise RpcError("Заявка уже отправлена")
        if old and old["status"] == "rejected":
            left = REJECT_COOLDOWN - (time.time() - (old["decided_at"] or 0))
            if left > 0:
                raise RpcError("Заявку отклонили. Новую можно отправить через %d ч." % max(1, round(left / 3600)))
        self.db.add_join_request(cid, conn.uid, clean_text(p.get("text"), 300))
        await self.push_requests(c, new_from=conn.uid)
        return {"request": "pending"}

    @rpc("join.cancel")
    async def h_join_cancel(self, conn, p):
        c = self.db.chat(as_int(p.get("chat")))
        r = c and self.db.join_request(c["id"], conn.uid)
        if r and r["status"] == "pending":
            self.db.delete_join_request(c["id"], conn.uid)
            await self.push_requests(c)
        return True

    @rpc("join.list")
    async def h_join_list(self, conn, p):
        c, _ = self.need_admin(p.get("chat"), conn.uid)
        return [{"user": self.pub_id(r["user_id"]), "text": r["text"], "ts": r["created_at"]}
                for r in self.db.join_requests(c["id"])]

    @rpc("join.decide")
    async def h_join_decide(self, conn, p):
        c, _ = self.need_admin(p.get("chat"), conn.uid)
        uid = as_int(p.get("user"))
        r = self.db.join_request(c["id"], uid)
        if not r or r["status"] != "pending":
            raise RpcError("Эту заявку уже рассмотрели")
        accept = bool(p.get("accept"))
        # сначала ответ заявителю, потом сам чат — так он увидит «заявку приняли», а не просто «вас добавили»
        await self.push_user(uid, "join_result", {"chat": c["id"], "title": c["title"], "accepted": accept})
        if accept:
            self.db.add_member(c["id"], uid)
            me, u = self.db.user(conn.uid), self.db.user(uid)
            await self.system_message(c["id"], conn.uid, "%s принял(а) заявку: %s теперь в группе" % (me["name"], u["name"]))
            await self.push_chat_state(c["id"])
            # кто-нибудь из участников в сети (обычно сам админ) передаст новичку ключ чата
            await self.push_chat(c["id"], "keys_needed", {"chat": c["id"]})
        else:
            self.db.reject_join_request(c["id"], uid)
        await self.push_requests(c)
        return True

    # ---------- поиск адресов ----------
    @rpc("geo.search")
    async def h_geo_search(self, conn, p):
        q = clean_line(p.get("q"), 200)
        if len(q) < 2:
            return []
        return await self.geo("search", {"q": q, "format": "jsonv2", "limit": "6", "addressdetails": "1"})

    @rpc("geo.reverse")
    async def h_geo_reverse(self, conn, p):
        lat, lon = as_coord(p.get("lat"), 90), as_coord(p.get("lon"), 180)
        found = await self.geo("reverse", {"lat": "%.5f" % lat, "lon": "%.5f" % lon, "format": "jsonv2",
                                           "zoom": "18", "addressdetails": "1"})
        return found[0] if found else None

    async def geo(self, kind, params):
        params["accept-language"] = "ru"
        key = kind + "?" + urlencode(sorted(params.items()))
        if key in self.geo_cache:
            self.geo_cache.move_to_end(key)
            return self.geo_cache[key]
        async with self.geo_lock:                     # не чаще одного запроса в секунду на весь сервер
            wait = self.geo_last + 1.1 - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            data = None
            try:
                if self.geo_http is None:
                    self.geo_http = aiohttp.ClientSession(headers={"User-Agent": GEO_UA},
                                                          timeout=aiohttp.ClientTimeout(total=12))
                async with self.geo_http.get(GEO_URL + kind, params=params) as r:
                    if r.status == 200:
                        data = await r.json(content_type=None)
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                data = None
            finally:
                self.geo_last = time.monotonic()
        if data is None:
            raise RpcError("Поиск адресов сейчас недоступен — попробуйте позже")
        items = data if isinstance(data, list) else ([data] if isinstance(data, dict) and "lat" in data else [])
        out = []
        for x in items:
            try:
                out.append(short_place(x))
            except (KeyError, TypeError, ValueError):
                continue
        self.geo_cache[key] = out
        while len(self.geo_cache) > 500:
            self.geo_cache.popitem(last=False)
        return out

    # ================= вкладки =================
    @rpc("tabs.create")
    async def h_tab_create(self, conn, p):
        c, _ = self.need_admin(p.get("chat"), conn.uid)
        name = clean_line(p.get("name"), 32)
        kind = p.get("kind") if p.get("kind") in ("text", "voice") else "text"
        if not name:
            raise RpcError("Укажите название вкладки")
        if len(self.db.tabs(c["id"])) >= 30:
            raise RpcError("Слишком много вкладок")
        tid = self.db.add_tab(c["id"], name, kind)
        await self.push_chat_state(c["id"])
        return {"id": tid}

    @rpc("tabs.rename")
    async def h_tab_rename(self, conn, p):
        t, _ = self.need_tab(p.get("tab"), conn.uid)
        self.need_admin(t["chat_id"], conn.uid)
        name = clean_line(p.get("name"), 32)
        if not name:
            raise RpcError("Укажите название вкладки")
        self.db.rename_tab(t["id"], name)
        await self.push_chat_state(t["chat_id"])
        return True

    @rpc("tabs.delete")
    async def h_tab_delete(self, conn, p):
        t, _ = self.need_tab(p.get("tab"), conn.uid)
        self.need_admin(t["chat_id"], conn.uid)
        tabs = self.db.tabs(t["chat_id"])
        if t["kind"] == "text" and sum(1 for x in tabs if x["kind"] == "text") <= 1:
            raise RpcError("Нельзя удалить последнюю текстовую вкладку")
        for c in list(self.conns.values()):
            if c.voice == t["id"]:
                await self.voice_leave(c)
                await c.send({"ev": "voice_kicked", "d": {"chat": t["chat_id"]}})
        self.db.delete_tab(t["id"])
        await self.push_chat_state(t["chat_id"])
        return True

    # ================= сообщения =================
    @rpc("messages.list")
    async def h_messages(self, conn, p):
        t, _ = self.need_tab(p.get("tab"), conn.uid)
        limit = max(1, min(as_int(p.get("limit") or 50), 100))
        before = as_int(p["before"]) if p.get("before") else None
        rows = self.db.messages(t["id"], before, limit + 1)
        has_more = len(rows) > limit
        rows = list(reversed(rows[:limit]))
        reactions = self.db.reactions([r["id"] for r in rows])
        msgs = [self.ser_message(r, reactions.get(r["id"], [])) for r in rows]
        uids = {r["user_id"] for r in rows if r["user_id"]}
        uids |= {m["reply"]["user"] for m in msgs if m["reply"] and m["reply"].get("user")}
        return {"messages": msgs, "has_more": has_more, "users": [self.pub_id(u) for u in uids]}

    @rpc("ping")
    async def h_ping(self, conn, p):
        """Проверка связи: клиент так замечает «зависшее» соединение (например, после переподключения туннеля)."""
        return True

    @rpc("messages.send")
    async def h_send(self, conn, p):
        """Сообщение приходит уже зашифрованным: текст, подпись, имя файла, длительность — всё внутри шифротекста.
        Сервер хранит и пересылает его как есть."""
        t, _ = self.need_tab(p.get("tab"), conn.uid)
        if t["kind"] != "text":
            raise RpcError("Во вкладку нельзя писать")
        kind = p.get("kind") or "text"
        if kind not in MESSAGE_KINDS:
            raise RpcError("Неизвестный тип сообщения")
        enc = validate_enc_payload(p.get("enc"))
        epoch = as_int(p.get("epoch"))
        self.check_epoch(t["chat_id"], epoch, conn.uid)
        media = self.own_media(conn.uid, p.get("media")) if kind not in ("text", "poll") else None
        reply_to = None
        if p.get("reply_to"):
            r = self.db.message(as_int(p["reply_to"]))
            if r and r["chat_id"] == t["chat_id"]:
                reply_to = r["id"]
        mid = self.db.add_message(t["chat_id"], t["id"], conn.uid, kind, enc, media, None, reply_to, epoch=epoch)
        self.db.set_read(t["id"], conn.uid, mid)
        msg = self.ser_message(self.db.message(mid), [])
        event = {"message": msg, "author": self.pub_id(conn.uid)}
        nonce = p.get("nonce")
        if isinstance(nonce, str) and 0 < len(nonce) <= 32:
            event["nonce"] = nonce          # отправитель заменяет им свой черновик «отправляется…»
        await self.push_chat(t["chat_id"], "message", event)
        await self.push_chat(t["chat_id"], "read", {"chat": t["chat_id"], "tab": t["id"], "user": conn.uid,
                                                    "upto": mid}, exclude_user=conn.uid)
        return {"message": msg}

    def need_message(self, mid, uid):
        r = self.db.message(as_int(mid))
        if not r:
            raise RpcError("Сообщение не найдено")
        return r, self.need_member(r["chat_id"], uid)

    @rpc("messages.get")
    async def h_message_get(self, conn, p):
        r, _ = self.need_message(p.get("id"), conn.uid)
        msg = self.ser_message(r)
        uids = {r["user_id"]} | ({msg["reply"]["user"]} if msg["reply"] and msg["reply"].get("user") else set())
        return {"message": msg, "users": [self.pub_id(u) for u in uids if u]}

    @rpc("messages.pin")
    async def h_pin(self, conn, p):
        """Закрепить сообщение во вкладке (id: null — открепить). В группах — только админы."""
        t, m = self.need_tab(p.get("tab"), conn.uid)
        c = self.db.chat(t["chat_id"])
        if c["type"] == "group" and m["role"] not in ("owner", "admin"):
            raise RpcError("Закреплять сообщения могут администраторы")
        mid = as_int(p["id"]) if p.get("id") else None
        if mid:
            r = self.db.message(mid)
            if not r or r["tab_id"] != t["id"] or r["kind"] == "system":
                raise RpcError("Сообщение не найдено")
        self.db.set_pinned(t["id"], mid)
        if c["type"] == "group":
            me = self.db.user(conn.uid)
            await self.system_message(c["id"], conn.uid, "%s %s сообщение" % (me["name"], "закрепил(а)" if mid else "открепил(а)"))
        await self.push_chat_state(c["id"])
        return True

    @rpc("polls.vote")
    async def h_vote(self, conn, p):
        r, _ = self.need_message(p.get("id"), conn.uid)
        if r["kind"] != "poll":
            raise RpcError("Это не опрос")
        option = as_int(p.get("option"))
        if not 0 <= option < 20:
            raise RpcError("Нет такого варианта")
        self.db.vote(r["id"], conn.uid, option)
        votes = self.db.poll_votes(r["id"])
        await self.push_chat(r["chat_id"], "poll_votes", {"id": r["id"], "tab": r["tab_id"], "votes": votes})
        return votes

    @rpc("messages.edit")
    async def h_edit(self, conn, p):
        r, _ = self.need_message(p.get("id"), conn.uid)
        if r["user_id"] != conn.uid or r["kind"] not in ("text", "image", "file"):
            raise RpcError("Это сообщение нельзя изменить")
        enc = validate_enc_payload(p.get("enc"))
        epoch = as_int(p.get("epoch"))
        self.check_epoch(r["chat_id"], epoch, conn.uid)
        self.db.edit_message(r["id"], enc, epoch)
        msg = self.ser_message(self.db.message(r["id"]))
        await self.push_chat(r["chat_id"], "message_edit", {"message": msg})
        return True

    @rpc("messages.delete")
    async def h_delete(self, conn, p):
        r, m = self.need_message(p.get("id"), conn.uid)
        c = self.db.chat(r["chat_id"])
        is_admin = c["type"] == "group" and m["role"] in ("owner", "admin")
        if r["user_id"] != conn.uid and not is_admin:
            raise RpcError("Можно удалять только свои сообщения")
        self.db.delete_message(r["id"])
        c = self.db.chat(r["chat_id"])
        last = self.db.message(c["last_msg_id"]) if c["last_msg_id"] else None
        await self.push_chat(r["chat_id"], "message_delete", {
            "chat": r["chat_id"], "tab": r["tab_id"], "id": r["id"],
            "last": self.ser_message(last, []) if last else None,
            "last_author": self.pub_id(last["user_id"]) if last else None})
        # непрочитанные могли измениться
        await self.push_chat_state(r["chat_id"])
        return True

    @rpc("messages.react")
    async def h_react(self, conn, p):
        r, _ = self.need_message(p.get("id"), conn.uid)
        emoji = str(p.get("emoji") or "")
        if emoji not in REACTIONS:
            raise RpcError("Такой реакции нет")
        if r["kind"] == "system":
            raise RpcError("Нельзя")
        self.db.toggle_reaction(r["id"], conn.uid, emoji)
        await self.push_chat(r["chat_id"], "reactions", {
            "chat": r["chat_id"], "tab": r["tab_id"], "id": r["id"],
            "reactions": self.db.reactions([r["id"]]).get(r["id"], [])})
        return True

    @rpc("messages.read")
    async def h_read(self, conn, p):
        t, _ = self.need_tab(p.get("tab"), conn.uid)
        upto = min(as_int(p.get("upto")), self.db.max_message_id(t["id"]))
        if upto > self.db.last_read(t["id"], conn.uid):
            self.db.set_read(t["id"], conn.uid, upto)
            data = {"chat": t["chat_id"], "tab": t["id"], "user": conn.uid, "upto": upto}
            await self.push_chat(t["chat_id"], "read", data, exclude_user=conn.uid)
            unread = self.db.unread_count(t["id"], conn.uid, upto)
            await self.push_user(conn.uid, "read", dict(data, unread=unread))
        return True

    @rpc("typing")
    async def h_typing(self, conn, p):
        t, _ = self.need_tab(p.get("tab"), conn.uid)
        me = self.db.user(conn.uid)
        await self.push_chat(t["chat_id"], "typing", {"chat": t["chat_id"], "tab": t["id"], "user": conn.uid,
                                                      "name": me["name"], "kind": p.get("kind") or "text"},
                             exclude_user=conn.uid)
        return True

    # ================= голос =================
    async def push_voice(self, tid):
        room = self.rooms.get(tid)
        t = self.db.tab(tid)
        cid = room["chat"] if room else (t["chat_id"] if t else None)
        if cid is None:
            return
        await self.push_chat(cid, "voice", {"chat": cid, "tab": tid, "parts": self.voice_parts(tid)})

    async def voice_leave(self, conn):
        tid = conn.voice
        if not tid:
            return
        conn.voice = None
        room = self.rooms.get(tid)
        if room:
            room["parts"].pop(conn.id, None)
            if not room["parts"]:
                self.rooms.pop(tid, None)
                await self.push_chat(room["chat"], "voice", {"chat": room["chat"], "tab": tid, "parts": []})
                return
        await self.push_voice(tid)

    @rpc("voice.join")
    async def h_voice_join(self, conn, p):
        t, _ = self.need_tab(p.get("tab"), conn.uid)
        if t["kind"] != "voice":
            raise RpcError("Это не голосовой канал")
        if conn.voice != t["id"]:
            await self.voice_leave(conn)
        room = self.rooms.setdefault(t["id"], {"chat": t["chat_id"], "parts": {}})
        present = {part["user"] for part in room["parts"].values()}
        video = video_kind(p.get("video"))
        room["parts"][conn.id] = {"user": conn.uid, "muted": bool(p.get("muted")),
                                  "deafened": bool(p.get("deafened")), "speaking": False, "video": video}
        conn.voice = t["id"]
        await self.push_voice(t["id"])
        c = self.db.chat(t["chat_id"])
        if c["type"] == "dm":
            peer = self.db.dm_peer(c["id"], conn.uid)
            if peer and peer not in present:
                await self.push_user(peer, "call", {"chat": c["id"], "tab": t["id"], "from": self.pub_id(conn.uid),
                                                    "video": video == "camera"})
        return {"peers": [cid for cid in room["parts"] if cid != conn.id]}

    @rpc("voice.leave")
    async def h_voice_leave(self, conn, p):
        await self.voice_leave(conn)
        return True

    @rpc("voice.state")
    async def h_voice_state(self, conn, p):
        room = self.rooms.get(conn.voice)
        if room and conn.id in room["parts"]:
            part = room["parts"][conn.id]
            part["muted"] = bool(p.get("muted"))
            part["deafened"] = bool(p.get("deafened"))
            part["video"] = video_kind(p.get("video"))
            if part["muted"]:
                part["speaking"] = False
            await self.push_voice(conn.voice)
        return True

    @rpc("voice.speaking")
    async def h_speaking(self, conn, p):
        room = self.rooms.get(conn.voice)
        if room and conn.id in room["parts"]:
            part = room["parts"][conn.id]
            value = bool(p.get("value")) and not part["muted"]
            if value != part["speaking"]:
                part["speaking"] = value
                await self.push_chat(room["chat"], "speaking", {"tab": conn.voice, "conn": conn.id,
                                                                "user": conn.uid, "value": value})
        return True

    @rpc("voice.signal")
    async def h_signal(self, conn, p):
        target = self.conns.get(str(p.get("to") or ""))
        if target and conn.voice and target.voice == conn.voice:
            await target.send({"ev": "signal", "d": {"from": conn.id, "data": p.get("data")}})
        return True

    @rpc("call.decline")
    async def h_call_decline(self, conn, p):
        t, _ = self.need_tab(p.get("tab"), conn.uid)
        room = self.rooms.get(t["id"])
        if room:
            for cid in list(room["parts"]):
                c = self.conns.get(cid)
                if c:
                    await c.send({"ev": "call_declined", "d": {"chat": t["chat_id"], "tab": t["id"], "by": conn.uid}})
        await self.push_user(conn.uid, "call_cancel", {"tab": t["id"]}, exclude_conn=conn.id)
        return True
