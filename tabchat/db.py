"""Хранилище на SQLite: пользователи, сессии, чаты, вкладки, сообщения, реакции, медиа."""
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name        TEXT NOT NULL,
    bio         TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL,
    avatar      TEXT,
    pw_hash     TEXT NOT NULL,
    created_at  REAL NOT NULL,
    last_seen   REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent       TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    last_active REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chats(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,              -- saved | dm | group
    title       TEXT NOT NULL DEFAULT '',
    about       TEXT NOT NULL DEFAULT '',
    avatar      TEXT,
    color       TEXT,
    owner_id    INTEGER,
    invite      TEXT UNIQUE,
    dm_key      TEXT UNIQUE,
    created_at  REAL NOT NULL,
    last_msg_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS members(
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
    muted       INTEGER NOT NULL DEFAULT 0,
    joined_at   REAL NOT NULL,
    PRIMARY KEY(chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS tabs(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,              -- text | voice
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS tabs_chat ON tabs(chat_id);
CREATE TABLE IF NOT EXISTS reads(
    tab_id      INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tab_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    tab_id      INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
    user_id     INTEGER,
    kind        TEXT NOT NULL,              -- text | image | file | voice | video_note | system
    text        TEXT NOT NULL DEFAULT '',
    media       TEXT,
    meta        TEXT,
    reply_to    INTEGER,
    created_at  REAL NOT NULL,
    edited_at   REAL
);
CREATE INDEX IF NOT EXISTS messages_tab ON messages(tab_id, id);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS reactions(
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    created_at  REAL NOT NULL,
    PRIMARY KEY(message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS media(
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL
);
"""

DEFAULT_TABS = {
    "group": [("Общий", "text"), ("Голосовой", "voice")],
    "dm": [("Сообщения", "text"), ("Звонок", "voice")],
    "saved": [("Заметки", "text")],
}


def now():
    return time.time()


def like_pattern(q):
    q = q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return "%" + q + "%"


class DB:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.c = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.c.row_factory = sqlite3.Row
        # встроенный lower() в SQLite понимает только латиницу
        self.c.create_function("pylower", 1, lambda s: s.lower() if isinstance(s, str) else s, deterministic=True)
        self.c.execute("PRAGMA journal_mode=WAL")
        self.c.execute("PRAGMA synchronous=NORMAL")
        self.c.execute("PRAGMA foreign_keys=ON")
        self.c.executescript(SCHEMA)
        self._depth = 0
        self.migrate()

    # ---------- миграции ----------
    def _columns(self, table):
        return {r["name"] for r in self.q("PRAGMA table_info(%s)" % table)}

    def _add_column(self, table, column, ddl):
        if column not in self._columns(table):
            self.c.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, ddl))

    def migrate(self):
        version = self.val("PRAGMA user_version") or 0
        if version < 2:
            # сквозное шифрование: ключи пользователей, ключи чатов по «эпохам», зашифрованные сообщения
            with self.tx():
                self._add_column("users", "kdf", "TEXT NOT NULL DEFAULT 'legacy'")   # legacy | v1
                self._add_column("users", "kdf_salt", "TEXT")
                self._add_column("users", "kdf_iters", "INTEGER")
                self._add_column("users", "key_ecdh", "TEXT")
                self._add_column("users", "key_sign", "TEXT")
                self._add_column("users", "key_backup", "TEXT")
                self._add_column("chats", "key_epoch", "INTEGER NOT NULL DEFAULT 1")
                self._add_column("messages", "enc", "INTEGER NOT NULL DEFAULT 0")
                self._add_column("messages", "epoch", "INTEGER")
                self.c.execute("""CREATE TABLE IF NOT EXISTS chat_keys(
                    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                    epoch      INTEGER NOT NULL,
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    wrapped    TEXT NOT NULL,
                    by_user    INTEGER NOT NULL,
                    created_at REAL NOT NULL,
                    PRIMARY KEY(chat_id, epoch, user_id))""")
                self.c.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)")
                self.c.execute("PRAGMA user_version = 2")
        if version < 3:
            # карта: группы, привязанные к адресу, и заявки на вступление в них
            with self.tx():
                self.c.execute("""CREATE TABLE IF NOT EXISTS chat_places(
                    chat_id    INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
                    lat        REAL NOT NULL,
                    lon        REAL NOT NULL,
                    address    TEXT NOT NULL DEFAULT '',
                    updated_by INTEGER,
                    updated_at REAL NOT NULL)""")
                self.c.execute("CREATE INDEX IF NOT EXISTS chat_places_geo ON chat_places(lat, lon)")
                self.c.execute("""CREATE TABLE IF NOT EXISTS join_requests(
                    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    text       TEXT NOT NULL DEFAULT '',
                    status     TEXT NOT NULL DEFAULT 'pending',      -- pending | rejected
                    created_at REAL NOT NULL,
                    decided_at REAL,
                    PRIMARY KEY(chat_id, user_id))""")
                self.c.execute("PRAGMA user_version = 3")
        if version < 4:
            # эмодзи вместо фото группы, закреплённое сообщение во вкладке, голоса в опросах
            with self.tx():
                self._add_column("chats", "emoji", "TEXT")
                self._add_column("tabs", "pinned", "INTEGER")
                self.c.execute("""CREATE TABLE IF NOT EXISTS poll_votes(
                    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    option     INTEGER NOT NULL,
                    PRIMARY KEY(message_id, user_id, option))""")
                self.c.execute("PRAGMA user_version = 4")
        if version < 5:
            # оформление чатов: тема для всех (chats.theme) и своя у каждого участника (members.theme)
            with self.tx():
                self._add_column("chats", "theme", "TEXT")
                self._add_column("members", "theme", "TEXT")
                self.c.execute("PRAGMA user_version = 5")

    def secret(self):
        """Секрет сервера (например, для «фальшивых» солей несуществующих пользователей)."""
        v = self.val("SELECT v FROM meta WHERE k='secret'")
        if not v:
            v = secrets.token_hex(32)
            self.run("INSERT OR IGNORE INTO meta(k, v) VALUES('secret', ?)", v)
            v = self.val("SELECT v FROM meta WHERE k='secret'")
        return v

    # ---------- базовые операции ----------
    @contextmanager
    def tx(self):
        """Транзакция (вложенные вызовы склеиваются в одну). Внутри нельзя делать await."""
        if self._depth == 0:
            self.c.execute("BEGIN")
        self._depth += 1
        try:
            yield
        except BaseException:
            self._depth -= 1
            if self._depth == 0:
                self.c.execute("ROLLBACK")
            raise
        else:
            self._depth -= 1
            if self._depth == 0:
                self.c.execute("COMMIT")

    def q(self, sql, *a):
        return self.c.execute(sql, a).fetchall()

    def one(self, sql, *a):
        return self.c.execute(sql, a).fetchone()

    def val(self, sql, *a):
        r = self.c.execute(sql, a).fetchone()
        return r[0] if r else None

    def run(self, sql, *a):
        return self.c.execute(sql, a).lastrowid

    # ---------- пользователи ----------
    def user(self, uid):
        return self.one("SELECT * FROM users WHERE id=?", uid)

    def user_by_username(self, username):
        return self.one("SELECT * FROM users WHERE username=?", username)

    def create_user(self, username, name, color, pw_hash, **crypto):
        with self.tx():
            uid = self.run("INSERT INTO users(username,name,color,pw_hash,created_at,last_seen) VALUES(?,?,?,?,?,?)",
                           username, name, color, pw_hash, now(), now())
            if crypto:
                self.update_user(uid, **crypto)
            cid = self.create_chat("saved", dm_key="saved:%d" % uid, owner=uid)
            self.add_member(cid, uid, "owner")
        return uid

    def users_keys(self, ids):
        if not ids:
            return []
        marks = ",".join("?" * len(ids))
        return self.q("SELECT id, key_ecdh, key_sign FROM users WHERE id IN (%s)" % marks, *ids)

    def update_user(self, uid, **fields):
        if not fields:
            return
        cols = ", ".join("%s=?" % k for k in fields)
        self.run("UPDATE users SET %s WHERE id=?" % cols, *fields.values(), uid)

    def search_users(self, q, limit=20):
        pat = like_pattern(q)
        prefix = q.lower().lstrip("@") + "%"
        return self.q(
            "SELECT * FROM users WHERE pylower(username) LIKE ? ESCAPE '\\' OR pylower(name) LIKE ? ESCAPE '\\' "
            "ORDER BY (pylower(username) LIKE ?) DESC, name LIMIT ?", pat, pat, prefix, limit)

    def co_member_ids(self, uid):
        """Все, с кем у пользователя есть общий чат (кому интересен его онлайн-статус и профиль)."""
        return {r[0] for r in self.q(
            "SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.chat_id=m2.chat_id "
            "WHERE m1.user_id=? AND m2.user_id<>?", uid, uid)}

    # ---------- сессии ----------
    def create_session(self, uid, token_hash, agent):
        self.run("INSERT INTO sessions(token_hash,user_id,agent,created_at,last_active) VALUES(?,?,?,?,?)",
                 token_hash, uid, agent[:200], now(), now())

    def session(self, token_hash):
        return self.one("SELECT * FROM sessions WHERE token_hash=?", token_hash)

    def touch_session(self, token_hash):
        self.run("UPDATE sessions SET last_active=? WHERE token_hash=?", now(), token_hash)

    def sessions(self, uid):
        return self.q("SELECT * FROM sessions WHERE user_id=? ORDER BY last_active DESC", uid)

    def delete_session(self, token_hash):
        self.run("DELETE FROM sessions WHERE token_hash=?", token_hash)

    # ---------- чаты ----------
    def create_chat(self, type_, title="", owner=None, dm_key=None, color=None):
        with self.tx():
            invite = secrets.token_urlsafe(9) if type_ == "group" else None
            cid = self.run("INSERT INTO chats(type,title,owner_id,dm_key,color,invite,created_at) VALUES(?,?,?,?,?,?,?)",
                           type_, title, owner, dm_key, color, invite, now())
            for pos, (name, kind) in enumerate(DEFAULT_TABS[type_]):
                self.add_tab(cid, name, kind, pos)
        return cid

    def chat(self, cid):
        return self.one("SELECT * FROM chats WHERE id=?", cid)

    def chat_by_key(self, key):
        return self.one("SELECT * FROM chats WHERE dm_key=?", key)

    def chat_by_invite(self, code):
        return self.one("SELECT * FROM chats WHERE invite=? AND type='group'", code)

    def update_chat(self, cid, **fields):
        cols = ", ".join("%s=?" % k for k in fields)
        self.run("UPDATE chats SET %s WHERE id=?" % cols, *fields.values(), cid)

    def delete_chat(self, cid):
        self.run("DELETE FROM chats WHERE id=?", cid)

    def user_chats(self, uid):
        return self.q("SELECT c.* FROM chats c JOIN members m ON m.chat_id=c.id WHERE m.user_id=?", uid)

    def add_member(self, cid, uid, role="member"):
        self.run("INSERT OR IGNORE INTO members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)", cid, uid, role, now())
        # вошёл любым путём (заявка, ссылка, добавили) — его заявка больше не нужна
        self.run("DELETE FROM join_requests WHERE chat_id=? AND user_id=?", cid, uid)

    def remove_member(self, cid, uid):
        self.run("DELETE FROM members WHERE chat_id=? AND user_id=?", cid, uid)

    def member(self, cid, uid):
        return self.one("SELECT * FROM members WHERE chat_id=? AND user_id=?", cid, uid)

    def members(self, cid):
        return self.q("SELECT * FROM members WHERE chat_id=? ORDER BY joined_at", cid)

    def member_ids(self, cid):
        return [r[0] for r in self.q("SELECT user_id FROM members WHERE chat_id=?", cid)]

    def member_count(self, cid):
        return self.val("SELECT COUNT(*) FROM members WHERE chat_id=?", cid)

    def set_member_theme(self, cid, uid, theme):
        self.run("UPDATE members SET theme=? WHERE chat_id=? AND user_id=?", theme, cid, uid)

    def set_role(self, cid, uid, role):
        self.run("UPDATE members SET role=? WHERE chat_id=? AND user_id=?", role, cid, uid)

    def set_muted(self, cid, uid, muted):
        self.run("UPDATE members SET muted=? WHERE chat_id=? AND user_id=?", 1 if muted else 0, cid, uid)

    def dm_peer(self, cid, uid):
        return self.val("SELECT user_id FROM members WHERE chat_id=? AND user_id<>?", cid, uid)

    # ---------- карта и заявки ----------
    def place(self, cid):
        return self.one("SELECT * FROM chat_places WHERE chat_id=?", cid)

    def set_place(self, cid, lat, lon, address, uid):
        self.run("INSERT INTO chat_places(chat_id,lat,lon,address,updated_by,updated_at) VALUES(?,?,?,?,?,?) "
                 "ON CONFLICT(chat_id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, address=excluded.address, "
                 "updated_by=excluded.updated_by, updated_at=excluded.updated_at", cid, lat, lon, address, uid, now())

    def clear_place(self, cid):
        self.run("DELETE FROM chat_places WHERE chat_id=?", cid)

    # карточка группы на карте: открытые данные + состоит ли смотрящий и его заявка
    PLACE_SELECT = (
        "SELECT p.chat_id, p.lat, p.lon, p.address, c.title, c.about, c.avatar, c.color, c.emoji, "
        "(SELECT COUNT(*) FROM members m WHERE m.chat_id=c.id) AS members, "
        "EXISTS(SELECT 1 FROM members m WHERE m.chat_id=c.id AND m.user_id=?) AS is_member, "
        "r.status AS req_status, r.decided_at AS req_decided "
        "FROM chat_places p JOIN chats c ON c.id=p.chat_id AND c.type='group' "
        "LEFT JOIN join_requests r ON r.chat_id=c.id AND r.user_id=? ")

    def places_in(self, uid, south, west, north, east, limit):
        # через линию перемены дат (west > east) окно по долготе разбивается на два куска
        lon = "p.lon BETWEEN ? AND ?" if west <= east else "(p.lon >= ? OR p.lon <= ?)"
        return self.q(self.PLACE_SELECT + "WHERE p.lat BETWEEN ? AND ? AND " + lon + " ORDER BY members DESC LIMIT ?",
                      uid, uid, south, north, west, east, limit)

    def place_card(self, uid, cid):
        return self.one(self.PLACE_SELECT + "WHERE p.chat_id=?", uid, uid, cid)

    def find_places(self, uid, q, limit=20):
        pat = like_pattern(q)
        return self.q(self.PLACE_SELECT + "WHERE pylower(c.title) LIKE ? ESCAPE '\\' OR pylower(p.address) LIKE ? ESCAPE '\\' "
                      "ORDER BY members DESC LIMIT ?", uid, uid, pat, pat, limit)

    def join_request(self, cid, uid):
        return self.one("SELECT * FROM join_requests WHERE chat_id=? AND user_id=?", cid, uid)

    def add_join_request(self, cid, uid, text):
        self.run("INSERT OR REPLACE INTO join_requests(chat_id,user_id,text,status,created_at) VALUES(?,?,?,'pending',?)",
                 cid, uid, text, now())

    def reject_join_request(self, cid, uid):
        self.run("UPDATE join_requests SET status='rejected', decided_at=? WHERE chat_id=? AND user_id=?", now(), cid, uid)

    def delete_join_request(self, cid, uid):
        self.run("DELETE FROM join_requests WHERE chat_id=? AND user_id=?", cid, uid)

    def join_requests(self, cid):
        return self.q("SELECT * FROM join_requests WHERE chat_id=? AND status='pending' ORDER BY created_at", cid)

    def pending_requests(self, cid):
        return self.val("SELECT COUNT(*) FROM join_requests WHERE chat_id=? AND status='pending'", cid)

    def admin_ids(self, cid):
        return [r[0] for r in self.q("SELECT user_id FROM members WHERE chat_id=? AND role IN ('owner','admin')", cid)]

    # ---------- вкладки ----------
    def add_tab(self, cid, name, kind, position=None):
        if position is None:
            position = (self.val("SELECT MAX(position) FROM tabs WHERE chat_id=?", cid) or 0) + 1
        return self.run("INSERT INTO tabs(chat_id,name,kind,position,created_at) VALUES(?,?,?,?,?)",
                        cid, name, kind, position, now())

    def tab(self, tid):
        return self.one("SELECT * FROM tabs WHERE id=?", tid)

    def tabs(self, cid):
        return self.q("SELECT * FROM tabs WHERE chat_id=? ORDER BY position, id", cid)

    def set_pinned(self, tid, mid):
        self.run("UPDATE tabs SET pinned=? WHERE id=?", mid, tid)

    def poll_votes(self, mid):
        out = {}
        for r in self.q("SELECT option, user_id FROM poll_votes WHERE message_id=? ORDER BY rowid", mid):
            out.setdefault(str(r["option"]), []).append(r["user_id"])
        return out

    def vote(self, mid, uid, option):
        """Один вариант на человека; повторный выбор того же варианта — отменить голос."""
        with self.tx():
            had = self.val("SELECT 1 FROM poll_votes WHERE message_id=? AND user_id=? AND option=?", mid, uid, option)
            self.run("DELETE FROM poll_votes WHERE message_id=? AND user_id=?", mid, uid)
            if not had:
                self.run("INSERT INTO poll_votes(message_id,user_id,option) VALUES(?,?,?)", mid, uid, option)

    def first_text_tab(self, cid):
        return self.val("SELECT id FROM tabs WHERE chat_id=? AND kind='text' ORDER BY position, id LIMIT 1", cid)

    def rename_tab(self, tid, name):
        self.run("UPDATE tabs SET name=? WHERE id=?", name, tid)

    def delete_tab(self, tid):
        with self.tx():
            cid = self.val("SELECT chat_id FROM tabs WHERE id=?", tid)
            self.run("DELETE FROM tabs WHERE id=?", tid)
            if cid:
                self.refresh_last(cid)

    # ---------- прочитанность ----------
    def last_read(self, tid, uid):
        return self.val("SELECT last_read FROM reads WHERE tab_id=? AND user_id=?", tid, uid) or 0

    def set_read(self, tid, uid, upto):
        self.run("INSERT INTO reads(tab_id,user_id,last_read) VALUES(?,?,?) "
                 "ON CONFLICT(tab_id,user_id) DO UPDATE SET last_read=MAX(last_read, excluded.last_read)",
                 tid, uid, upto)

    def others_read(self, tid, uid):
        return self.val("SELECT MAX(last_read) FROM reads WHERE tab_id=? AND user_id<>?", tid, uid) or 0

    def unread_count(self, tid, uid, last_read):
        return self.val("SELECT COUNT(*) FROM messages WHERE tab_id=? AND id>? AND kind<>'system' "
                        "AND (user_id IS NULL OR user_id<>?)", tid, last_read, uid)

    def max_message_id(self, tid):
        return self.val("SELECT MAX(id) FROM messages WHERE tab_id=?", tid) or 0

    # ---------- сообщения ----------
    def add_message(self, cid, tid, uid, kind, text="", media=None, meta=None, reply_to=None, epoch=None):
        """epoch задан → text это шифротекст (сервер его не понимает и не должен)."""
        with self.tx():
            mid = self.run("INSERT INTO messages(chat_id,tab_id,user_id,kind,text,media,meta,reply_to,created_at,enc,epoch) "
                           "VALUES(?,?,?,?,?,?,?,?,?,?,?)", cid, tid, uid, kind, text, media,
                           json.dumps(meta, ensure_ascii=False) if meta else None, reply_to, now(),
                           1 if epoch is not None else 0, epoch)
            self.run("UPDATE chats SET last_msg_id=? WHERE id=?", mid, cid)
        return mid

    def message(self, mid):
        return self.one("SELECT * FROM messages WHERE id=?", mid)

    def messages(self, tid, before=None, limit=50):
        if before:
            return self.q("SELECT * FROM messages WHERE tab_id=? AND id<? ORDER BY id DESC LIMIT ?", tid, before, limit)
        return self.q("SELECT * FROM messages WHERE tab_id=? ORDER BY id DESC LIMIT ?", tid, limit)

    def edit_message(self, mid, text, epoch=None):
        if epoch is None:
            self.run("UPDATE messages SET text=?, edited_at=? WHERE id=?", text, now(), mid)
        else:
            self.run("UPDATE messages SET text=?, epoch=?, enc=1, edited_at=? WHERE id=?", text, epoch, now(), mid)

    def delete_message(self, mid):
        with self.tx():
            cid = self.val("SELECT chat_id FROM messages WHERE id=?", mid)
            self.run("DELETE FROM messages WHERE id=?", mid)
            self.run("UPDATE tabs SET pinned=NULL WHERE pinned=?", mid)
            if cid:
                self.refresh_last(cid)

    def refresh_last(self, cid):
        last = self.val("SELECT MAX(id) FROM messages WHERE chat_id=?", cid) or 0
        self.run("UPDATE chats SET last_msg_id=? WHERE id=?", last, cid)

    # ---------- ключи чатов (сквозное шифрование) ----------
    def bump_epoch(self, cid):
        """Новая «эпоха» ключа: старым участникам новый ключ уже не достанется."""
        self.run("UPDATE chats SET key_epoch = key_epoch + 1 WHERE id=?", cid)
        return self.val("SELECT key_epoch FROM chats WHERE id=?", cid)

    def chat_keys_of(self, cid, uid):
        return self.q("SELECT epoch, wrapped FROM chat_keys WHERE chat_id=? AND user_id=? ORDER BY epoch", cid, uid)

    def has_chat_key(self, cid, epoch, uid=None):
        if uid is None:
            return bool(self.one("SELECT 1 FROM chat_keys WHERE chat_id=? AND epoch=? LIMIT 1", cid, epoch))
        return bool(self.one("SELECT 1 FROM chat_keys WHERE chat_id=? AND epoch=? AND user_id=?", cid, epoch, uid))

    def add_chat_key(self, cid, epoch, uid, wrapped, by_user):
        cur = self.c.execute("INSERT OR IGNORE INTO chat_keys(chat_id,epoch,user_id,wrapped,by_user,created_at) "
                             "VALUES(?,?,?,?,?,?)", (cid, epoch, uid, wrapped, by_user, now()))
        return cur.rowcount > 0

    def missing_chat_keys(self, cid, epochs):
        """Для каждой эпохи — участники с ключами шифрования, которым ключ чата ещё не передали."""
        out = {}
        for epoch in epochs:
            rows = self.q("SELECT m.user_id FROM members m JOIN users u ON u.id=m.user_id "
                          "WHERE m.chat_id=? AND u.key_ecdh IS NOT NULL AND NOT EXISTS ("
                          "SELECT 1 FROM chat_keys k WHERE k.chat_id=m.chat_id AND k.epoch=? AND k.user_id=m.user_id)",
                          cid, epoch)
            if rows:
                out[epoch] = [r[0] for r in rows]
        return out

    # ---------- реакции ----------
    def toggle_reaction(self, mid, uid, emoji):
        if self.one("SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?", mid, uid, emoji):
            self.run("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?", mid, uid, emoji)
        else:
            self.run("INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)", mid, uid, emoji, now())

    def reactions(self, mids):
        """{message_id: [{"e": emoji, "u": [user_ids]}]} в порядке появления реакций."""
        out = {}
        if not mids:
            return out
        marks = ",".join("?" * len(mids))
        for r in self.q("SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (%s) "
                        "ORDER BY created_at" % marks, *mids):
            groups = out.setdefault(r["message_id"], [])
            g = next((g for g in groups if g["e"] == r["emoji"]), None)
            if g is None:
                g = {"e": r["emoji"], "u": []}
                groups.append(g)
            g["u"].append(r["user_id"])
        return out

    # ---------- медиа ----------
    def add_media(self, mid, uid, mime, size, name):
        self.run("INSERT INTO media(id,user_id,mime,size,name,created_at) VALUES(?,?,?,?,?,?)",
                 mid, uid, mime, size, name, now())

    def media(self, mid):
        return self.one("SELECT * FROM media WHERE id=?", mid)
