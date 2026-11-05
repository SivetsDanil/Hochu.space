"""Сквозная проверка сервера: аккаунты, сквозное шифрование, чаты, сообщения, файлы, голос.

Запуск:  .venv\\Scripts\\python tests\\smoke_test.py
Поднимает сервер на свободном порту с временной папкой данных и гоняет API.
Сервер не умеет (и не должен) проверять криптографию — тест шлёт данные правильной формы,
а настоящее шифрование проверяется в браузере.
"""
import asyncio
import base64
import itertools
import json
import os
import shutil
import sys
import tempfile

import aiohttp
from aiohttp import web

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tabchat import appclient, security  # noqa: E402
from tabchat.db import DB  # noqa: E402
from tabchat.web import make_app  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rb64(n):
    return base64.b64encode(os.urandom(n)).decode()


def identity():
    return {"ke": rb64(65), "ks": rb64(65), "backup": {"v": 1, "iv": rb64(12), "ct": rb64(200)}}


def creds():
    return {"auth": os.urandom(32).hex(), "salt": rb64(16), "iters": 310000, "keys": identity()}


def enc():
    return {"iv": rb64(12), "ct": rb64(40), "sig": rb64(64)}


def wrapped(by):
    return {"v": 1, "by": by, "iv": rb64(12), "ct": rb64(48)}


class Client:
    def __init__(self, session, base, token, uid):
        self.session, self.base, self.token, self.uid = session, base, token, uid
        self.ids = itertools.count(1)
        self.pending = {}
        self.events = []

    async def connect(self):
        self.ws = await self.session.ws_connect(self.base.replace("http", "ws") + "/ws")
        self.reader = asyncio.ensure_future(self._read())
        return await self.call("auth", token=self.token)

    async def _read(self):
        async for msg in self.ws:
            data = msg.json()
            if "ev" in data:
                self.events.append(data)
            elif data.get("id") in self.pending:
                self.pending.pop(data["id"]).set_result(data)

    async def call(self, method, **params):
        rid = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        await self.ws.send_json({"id": rid, "m": method, "p": params})
        res = await asyncio.wait_for(fut, 5)
        if "err" in res:
            raise AssertionError("%s: %s" % (method, res["err"]))
        return res["ok"]

    async def fail(self, method, **params):
        try:
            await self.call(method, **params)
        except AssertionError as e:
            return str(e)
        raise AssertionError("%s должен был вернуть ошибку" % method)

    def got(self, ev):
        return [e["d"] for e in self.events if e["ev"] == ev]

    async def create_key(self, chat, epoch, members):
        """Первый ключ эпохи: «зашифрован» для каждого участника."""
        return await self.call("keys.put", chat=chat, create=True,
                               keys=[{"epoch": epoch, "user": u, "wrapped": wrapped(self.uid)} for u in members])

    async def send(self, tab, epoch, **extra):
        return await self.call("messages.send", tab=tab, epoch=epoch, enc=enc(), **extra)


def free_port():
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def main():
    tmp = tempfile.mkdtemp(prefix="tabchat-test-")
    db = DB(os.path.join(tmp, "t.db"))
    app = make_app(db, os.path.join(ROOT, "static"), os.path.join(tmp, "media"))
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    base = "http://127.0.0.1:%d" % port

    async with aiohttp.ClientSession() as s:
        async def post(path, **body):
            async with s.post(base + path, json=body) as r:
                return r.status, await r.json()

        async def register(username, name):
            c = creds()
            st, res = await post("/api/register", username=username, name=name, **c)
            assert st == 200, res
            res["creds"] = c
            return res

        # --- страница, статика и сведения о сервере ---
        async with s.get(base + "/") as r:
            page = await r.text()
            assert r.status == 200 and '<script type="importmap">' in page and "modulepreload" in page
        async with s.get(base + "/") as r:
            policy = r.headers["Content-Security-Policy"]
            assert "script-src 'self' 'sha256-" in policy and "frame-ancestors 'none'" in policy, policy
        async with s.get(base + "/static/js/main.js", headers={"Accept-Encoding": "gzip"}) as r:
            assert r.status == 200 and r.headers["Content-Encoding"] == "gzip" and r.headers["Cache-Control"] == "no-cache"
            etag = r.headers["ETag"]
        async with s.get(base + "/static/js/main.js?v=" + etag.strip('"'), headers={"If-None-Match": etag}) as r:
            assert r.status == 304
        async with s.get(base + "/static/../server.py") as r:
            assert r.status == 404
        async with s.get(base + "/api/info") as r:
            sinfo = await r.json()
            assert sinfo["app"] == "TabChat" and sinfo["protocol"] >= 1 and len(sinfo["server_id"]) == 16
        async with s.get(base + "/download/windows") as r:
            assert r.status == 404, "приложения рядом нет — и скачивать нечего"
        print("✓ страница, статика с версиями и gzip, /api/info")

        # --- регистрация и вход без пароля на сервере ---
        alice = await register("alice", "Алиса")
        bob = await register("bob_99", "Боб")
        st, err = await post("/api/register", username="Alice", name="X", **creds())
        assert st == 409, "username должен быть уникален без учёта регистра"
        st, err = await post("/api/register", username="1bad", name="X", **creds())
        assert st == 400
        st, err = await post("/api/register", username="plainpw", name="X", password="secret1")
        assert st == 400 and "устарела" in err["error"], "старый вход по паролю больше не принимается"
        st, pre = await post("/api/prelogin", username="alice")
        assert pre == {"kdf": "v1", "salt": alice["creds"]["salt"], "iters": 310000}, pre
        st, fake1 = await post("/api/prelogin", username="nobody_here")
        st, fake2 = await post("/api/prelogin", username="nobody_here")
        assert fake1 == fake2 and fake1["kdf"] == "v1", "для несуществующих — правдоподобная постоянная соль"
        st, err = await post("/api/login", username="alice", auth=os.urandom(32).hex())
        assert st == 401
        st, login = await post("/api/login", username="@alice", auth=alice["creds"]["auth"])
        assert st == 200 and login["user"]["id"] == alice["user"]["id"]
        assert login["backup"]["ct"] == alice["creds"]["keys"]["backup"]["ct"], "при входе отдаётся копия ключей"
        assert login["user"]["ke"] == alice["creds"]["keys"]["ke"]
        print("✓ регистрация и вход: пароль не уходит на сервер, копия ключей зашифрована")

        # --- старый аккаунт: однократный переход на новую схему ---
        db.create_user("old_timer", "Старожил", "#65aadd", security.hash_password("oldpass1"))
        st, pre = await post("/api/prelogin", username="old_timer")
        assert pre == {"kdf": "legacy"}
        st, err = await post("/api/login", username="old_timer", password="wrong", upgrade=creds())
        assert st == 401
        up = creds()
        st, res = await post("/api/login", username="old_timer", password="oldpass1", upgrade=up)
        assert st == 200 and res["backup"]["ct"] == up["keys"]["backup"]["ct"], res
        st, err = await post("/api/login", username="old_timer", password="oldpass1")
        assert st == 400 and "обновите" in err["error"], "после перехода обычный пароль больше не работает"
        st, res = await post("/api/login", username="old_timer", auth=up["auth"])
        assert st == 200
        print("✓ старый аккаунт переходит на сквозное шифрование при входе")
        target = await register("brute_target", "Мишень")
        for _ in range(8):
            st, err = await post("/api/login", username="brute_target", auth=os.urandom(32).hex())
            assert st == 401
        st, err = await post("/api/login", username="Brute_Target", auth=target["creds"]["auth"])
        assert st == 429 and "Слишком много" in err["error"], "после серии неудач даже верный пароль ждёт"
        print("✓ подбор пароля: после 8 неудачных попыток вход в аккаунт на паузе")

        a = Client(s, base, alice["token"], alice["user"]["id"])
        b = Client(s, base, bob["token"], bob["user"]["id"])
        await a.connect()
        await b.connect()
        sync = await a.call("sync")
        assert [c["type"] for c in sync["chats"]] == ["saved"]
        assert "server" in sync and sync["server"]["public_url"] is None
        info = await a.call("keys.info")
        assert info["kdf"] == "v1" and info["has_keys"] and info["salt"] == alice["creds"]["salt"]
        print("✓ sync и keys.info")

        # старый аккаунт с сессией, открытой ещё до обновления, включает шифрование по паролю
        uid2 = db.create_user("old_two", "Ещё старожил", "#65aadd", security.hash_password("oldpass2"))
        st, err = await post("/api/login", username="old_two", password="oldpass2")
        assert st == 400 and "устарела" in err["error"], "устаревшая страница без upgrade не входит"
        token2, th2 = security.new_token()
        db.create_session(uid2, th2, "old browser")
        o2 = Client(s, base, token2, uid2)
        await o2.connect()
        assert (await o2.call("keys.info"))["kdf"] == "legacy"
        await o2.fail("keys.upgrade", password="nope", **creds())
        await o2.call("keys.upgrade", password="oldpass2", **creds())
        assert (await o2.call("keys.info"))["has_keys"]
        print("✓ keys.upgrade для уже открытой сессии")

        # --- личка: ключ чата, зашифрованные сообщения ---
        dm = await a.call("chats.open_dm", user=bob["user"]["id"])
        assert dm["peer"]["ke"] == bob["creds"]["keys"]["ke"], "у собеседника видны открытые ключи"
        text_tab = next(t for t in dm["tabs"] if t["kind"] == "text")
        kc = await a.call("keys.chat", chat=dm["id"])
        assert kc == {"chat": dm["id"], "epoch": 1, "exists": False, "mine": [], "missing": []}, kc
        await a.fail("messages.send", tab=text_tab["id"], text="открытым текстом")
        err = await a.fail("messages.send", tab=text_tab["id"], epoch=1, enc=enc())
        assert "e2e:nokey" in err
        assert (await a.create_key(dm["id"], 1, [alice["user"]["id"], bob["user"]["id"]]))["ok"]
        conflict = await b.create_key(dm["id"], 1, [alice["user"]["id"], bob["user"]["id"]])
        assert conflict == {"conflict": True}, "второй ключ той же эпохи не принимается"
        kc_b = await b.call("keys.chat", chat=dm["id"])
        assert kc_b["exists"] and kc_b["mine"][0]["wrapped"]["by"] == alice["user"]["id"]
        err = await a.fail("messages.send", tab=text_tab["id"], epoch=2, enc=enc())
        assert "e2e:stale" in err
        sent = await a.send(text_tab["id"], 1)
        await asyncio.sleep(0.1)
        got = b.got("message")[-1]["message"]
        assert got["enc"] == 1 and got["epoch"] == 1 and json.loads(got["text"])["sig"], got
        stored = db.message(sent["message"]["id"])
        assert stored["enc"] == 1 and "открыт" not in stored["text"]
        bob_chat = await b.call("chats.get", id=dm["id"])
        assert bob_chat["tabs"][0]["unread"] == 1
        await b.call("messages.read", tab=text_tab["id"], upto=sent["message"]["id"])
        await asyncio.sleep(0.1)
        assert any(r["user"] == bob["user"]["id"] for r in a.got("read"))
        print("✓ ключ чата: создание, гонка, зашифрованные сообщения, прочтение")

        # --- ответы, правка, реакции, удаление ---
        reply = await b.send(text_tab["id"], 1, reply_to=sent["message"]["id"])
        rp = reply["message"]["reply"]
        assert rp["enc"] == 1 and rp["epoch"] == 1 and json.loads(rp["text"])["ct"], "превью ответа — шифротекст"
        await a.call("messages.edit", id=sent["message"]["id"], epoch=1, enc=enc())
        await b.fail("messages.edit", id=sent["message"]["id"], epoch=1, enc=enc())
        await b.call("messages.react", id=sent["message"]["id"], emoji="🔥")
        await asyncio.sleep(0.1)
        assert a.got("reactions")[-1]["reactions"] == [{"e": "🔥", "u": [bob["user"]["id"]]}]
        await b.fail("messages.delete", id=sent["message"]["id"])
        await a.call("messages.delete", id=sent["message"]["id"])
        page = await a.call("messages.list", tab=text_tab["id"])
        assert [m["id"] for m in page["messages"]] == [reply["message"]["id"]]
        assert page["messages"][0]["reply"]["deleted"] is True
        print("✓ ответы, редактирование, реакции, удаление")

        # --- группа: эпохи ключа, передача ключа новичкам, смена ключа при исключении ---
        carl = await register("carl", "Карл")
        c = Client(s, base, carl["token"], carl["user"]["id"])
        await c.connect()
        group = await a.call("chats.create_group", title="Команда", members=[bob["user"]["id"]])
        gtab = next(t for t in group["tabs"] if t["kind"] == "text")
        await a.create_key(group["id"], 1, [alice["user"]["id"], bob["user"]["id"]])
        await b.fail("tabs.create", chat=group["id"], name="Идеи", kind="text")
        await a.call("tabs.create", chat=group["id"], name="Идеи", kind="text")
        joined = await c.call("chats.join", code=group["invite"])
        assert joined["members"] == 3
        await asyncio.sleep(0.1)
        assert any(e["chat"] == group["id"] for e in a.got("keys_needed")), "участникам сказали передать ключ"
        kc = await a.call("keys.chat", chat=group["id"])
        assert kc["missing"] == [{"epoch": 1, "users": [carl["user"]["id"]]}], kc
        res = await c.call("keys.put", chat=group["id"], keys=[{"epoch": 1, "user": carl["user"]["id"],
                                                                "wrapped": wrapped(carl["user"]["id"])}])
        assert res["added"] == 0, "раздавать можно только ключи, которые знаешь сам"
        await a.call("keys.put", chat=group["id"], keys=[{"epoch": 1, "user": carl["user"]["id"],
                                                          "wrapped": wrapped(alice["user"]["id"])}])
        await asyncio.sleep(0.1)
        assert any(e["chat"] == group["id"] for e in c.got("keys")), "новичку пришёл ключ"
        assert (await c.call("keys.chat", chat=group["id"]))["mine"][0]["epoch"] == 1
        await c.send(gtab["id"], 1)
        print("✓ новичок получает ключ от участника в сети")

        await a.call("chats.set_role", id=group["id"], user=bob["user"]["id"], role="admin")
        await b.call("chats.kick", id=group["id"], user=carl["user"]["id"])
        await asyncio.sleep(0.1)
        assert c.got("chat_removed")
        await c.fail("messages.list", tab=gtab["id"])
        err = await b.fail("messages.send", tab=gtab["id"], epoch=1, enc=enc())
        assert "e2e:stale" in err, "после исключения старый ключ не годится"
        kc = await b.call("keys.chat", chat=group["id"])
        assert kc["epoch"] == 2 and not kc["exists"]
        await b.create_key(group["id"], 2, [alice["user"]["id"], bob["user"]["id"]])
        await b.send(gtab["id"], 2)
        # у участника нет ключа текущей эпохи — он может начать новую
        dave = await register("dave", "Дейв")
        d = Client(s, base, dave["token"], dave["user"]["id"])
        await d.connect()
        await d.call("chats.join", code=group["invite"])
        assert (await d.call("keys.rotate", chat=group["id"], **{"from": 2}))["epoch"] == 3
        assert (await a.call("keys.rotate", chat=group["id"], **{"from": 3}))["epoch"] == 3, "у кого ключ есть — не крутит"
        await a.call("chats.leave", id=group["id"])
        g = await b.call("chats.get", id=group["id"])
        assert g["role"] == "owner"
        print("✓ исключение и выход меняют эпоху ключа, keys.rotate, роли")

        # --- файлы: на сервер уходит только шифротекст ---
        blob = os.urandom(5000)
        async with s.post(base + "/api/upload", data=blob, headers={
                "Authorization": "Bearer " + alice["token"], "Content-Type": "application/octet-stream",
                "X-File-Name": "blob"}) as r:
            up = await r.json()
            assert r.status == 200, up
        async with s.post(base + "/api/upload", data=b"x") as r:
            assert r.status == 401
        vm = await a.send(text_tab["id"], 1, kind="voice", media=up["id"])
        assert vm["message"]["meta"] == {}, "имя, длительность и волна — только внутри шифротекста"
        async with s.get(base + "/media/" + up["id"]) as r:
            assert r.status == 200 and await r.read() == blob
        async with s.get(base + "/media/" + up["id"], headers={"Range": "bytes=0-99"}) as r:
            assert r.status == 206 and len(await r.read()) == 100
        async with s.post(base + "/api/upload", data=b"<script>alert(1)</script>", headers={
                "Authorization": "Bearer " + alice["token"], "Content-Type": "text/html", "X-File-Name": "x.html"}) as r:
            html = await r.json()
        async with s.get(base + "/media/" + html["id"]) as r:
            assert r.headers["Content-Type"] == "application/octet-stream"
            assert r.headers["Content-Disposition"].startswith("attachment")
        await b.fail("messages.send", tab=text_tab["id"], epoch=1, enc=enc(), kind="voice", media=up["id"])
        print("✓ файлы: шифротекст, Range, защита от HTML, чужой файл не прикрепить")

        # --- голос, звонки, видео ---
        voice_tab = next(t for t in dm["tabs"] if t["kind"] == "voice")
        joined = await a.call("voice.join", tab=voice_tab["id"])
        assert joined["peers"] == []
        await asyncio.sleep(0.1)
        assert b.got("call") and b.got("call")[-1]["from"]["username"] == "alice"
        joined = await b.call("voice.join", tab=voice_tab["id"])
        await b.call("voice.signal", to=joined["peers"][0], data={"sdp": "x", "sig": "y"})
        await asyncio.sleep(0.1)
        assert a.got("signal")[-1]["data"] == {"sdp": "x", "sig": "y"}
        await b.call("voice.state", muted=False, deafened=False, video="screen")
        await asyncio.sleep(0.1)
        bob_part = next(p for p in a.got("voice")[-1]["parts"] if p["user"] == bob["user"]["id"])
        assert bob_part["video"] == "screen"
        await a.call("voice.leave")
        await b.call("voice.leave")
        await a.call("voice.join", tab=voice_tab["id"], video="camera")
        await asyncio.sleep(0.1)
        assert b.got("call")[-1]["video"] is True
        await a.call("voice.leave")
        print("✓ голосовые комнаты, звонки, видео, сигналинг")

        # --- профиль, сессии, смена пароля без пароля ---
        await a.call("profile.update", name="Алиса Л.", bio="Тестирую")
        await b.fail("profile.update", username="alice")
        await asyncio.sleep(0.1)
        assert b.got("user")[-1]["user"]["name"] == "Алиса Л."
        sessions = await a.call("sessions.list")
        assert len(sessions) == 2 and sum(x["current"] for x in sessions) == 1
        await a.call("sessions.revoke", others=True)
        assert len(await a.call("sessions.list")) == 1
        new = creds()
        await a.fail("auth.password", old_auth=os.urandom(32).hex(), auth=new["auth"], salt=new["salt"],
                     iters=new["iters"], backup=new["keys"]["backup"])
        await a.call("auth.password", old_auth=alice["creds"]["auth"], auth=new["auth"], salt=new["salt"],
                     iters=new["iters"], backup=new["keys"]["backup"])
        st, res = await post("/api/login", username="alice", auth=new["auth"])
        assert st == 200 and res["backup"]["ct"] == new["keys"]["backup"]["ct"]
        st, pre = await post("/api/prelogin", username="alice")
        assert pre["salt"] == new["salt"]
        print("✓ профиль, сессии, смена пароля (ключи перешифрованы в браузере)")

        # --- карта: место группы, поиск, заявки на вступление ---
        dave_id = dave["user"]["id"]
        yard = await b.call("chats.create_group", title="Двор на Ленина")
        ytab = next(t for t in yard["tabs"] if t["kind"] == "text")
        await d.fail("places.set", chat=yard["id"], lat=55.75, lon=37.61)
        await b.fail("places.set", chat=yard["id"], lat=91, lon=0)
        await b.call("places.set", chat=yard["id"], lat=55.7512, lon=37.6184, address="ул. Ленина, 1")
        g = await b.call("chats.get", id=yard["id"])
        assert g["place"] == {"lat": 55.7512, "lon": 37.6184, "address": "ул. Ленина, 1"} and g["requests"] == 0, g
        found = await d.call("places.search", south=55.7, west=37.5, north=55.8, east=37.7)
        card = next(x for x in found if x["chat"] == yard["id"])
        assert card["title"] == "Двор на Ленина" and card["members"] == 1, card
        assert not card["member"] and card["request"] is None
        assert not any(x["chat"] == yard["id"] for x in await d.call("places.search", south=10, west=10, north=11, east=11))
        across = await d.call("places.search", south=55, west=170, north=56, east=40)
        assert any(x["chat"] == yard["id"] for x in across), "окно через линию перемены дат"
        assert any(x["chat"] == yard["id"] for x in await d.call("places.find", q="ЛЕНИНА")), "поиск по названию без регистра"
        await d.fail("join.list", chat=yard["id"])
        assert await d.call("join.request", chat=yard["id"], text="Живу в соседнем доме") == {"request": "pending"}
        assert "уже" in await d.fail("join.request", chat=yard["id"])
        await d.fail("messages.list", tab=ytab["id"])
        await asyncio.sleep(0.1)
        assert any(e["chat"] == yard["id"] and e["user"]["id"] == dave_id for e in b.got("join_request"))
        assert (await b.call("chats.get", id=yard["id"]))["requests"] == 1
        assert (await b.call("join.list", chat=yard["id"]))[0]["text"] == "Живу в соседнем доме"
        await b.call("join.decide", chat=yard["id"], user=dave_id, accept=True)
        await asyncio.sleep(0.1)
        assert d.got("join_result")[-1] == {"chat": yard["id"], "title": "Двор на Ленина", "accepted": True}
        assert any(e["chat"]["id"] == yard["id"] for e in d.got("chat")), "новичку пришёл чат"
        assert any(e["chat"] == yard["id"] for e in b.got("keys_needed")), "админа попросили передать ключ"
        g = await b.call("chats.get", id=yard["id"])
        assert g["requests"] == 0 and g["members"] == 2
        await d.call("messages.list", tab=ytab["id"])
        await b.fail("join.decide", chat=yard["id"], user=dave_id, accept=True)
        erin = await register("erin", "Эрин")
        e = Client(s, base, erin["token"], erin["user"]["id"])
        await e.connect()
        await e.call("join.request", chat=yard["id"])
        await b.call("join.decide", chat=yard["id"], user=erin["user"]["id"], accept=False)
        await asyncio.sleep(0.1)
        assert e.got("join_result")[-1]["accepted"] is False
        assert "через" in await e.fail("join.request", chat=yard["id"]), "после отказа — пауза"
        assert (await e.call("places.get", chat=yard["id"]))["request"] == "rejected"
        await c.call("join.request", chat=yard["id"])
        await c.call("join.cancel", chat=yard["id"])
        assert (await c.call("places.get", chat=yard["id"]))["request"] is None
        assert (await b.call("chats.get", id=yard["id"]))["requests"] == 0
        await d.fail("places.clear", chat=yard["id"])
        await b.call("places.clear", chat=yard["id"])
        await e.fail("places.get", chat=yard["id"])
        await c.fail("join.request", chat=yard["id"])
        assert (await b.call("chats.get", id=yard["id"]))["place"] is None
        print("✓ карта: место группы, поиск, заявки, принятие и отказ")

        # --- эмодзи группы, опросы, закреплённые сообщения ---
        await b.call("chats.update", id=yard["id"], emoji="🏠", color="#7bc862")
        g = await b.call("chats.get", id=yard["id"])
        assert g["emoji"] == "🏠" and g["color"] == "#7bc862"
        await b.fail("chats.update", id=yard["id"], color="red")
        await b.create_key(yard["id"], 1, [bob["user"]["id"], dave_id])
        poll = (await b.send(ytab["id"], 1, kind="poll"))["message"]
        assert poll["votes"] == {}
        assert await d.call("polls.vote", id=poll["id"], option=1) == {"1": [dave_id]}
        assert await d.call("polls.vote", id=poll["id"], option=1) == {}, "повторный выбор отменяет голос"
        await d.call("polls.vote", id=poll["id"], option=2)
        assert await b.call("polls.vote", id=poll["id"], option=2) == {"2": [dave_id, bob["user"]["id"]]}
        await d.fail("polls.vote", id=poll["id"], option=99)
        text = (await d.send(ytab["id"], 1))["message"]
        await d.fail("polls.vote", id=text["id"], option=0)
        await d.fail("messages.pin", tab=ytab["id"], id=text["id"]), "в группе закрепляют админы"
        await b.call("messages.pin", tab=ytab["id"], id=text["id"])
        tabs = {t["id"]: t for t in (await d.call("chats.get", id=yard["id"]))["tabs"]}
        assert tabs[ytab["id"]]["pinned"] == text["id"]
        assert (await d.call("messages.get", id=text["id"]))["message"]["id"] == text["id"]
        await e.fail("messages.get", id=text["id"])
        await d.call("messages.delete", id=text["id"])
        tabs = {t["id"]: t for t in (await d.call("chats.get", id=yard["id"]))["tabs"]}
        assert tabs[ytab["id"]]["pinned"] is None, "удалённое сообщение снимается с закрепа"
        print("✓ эмодзи группы, опросы, закреплённые сообщения")

        # --- оформление чата ---
        await b.call("chats.theme", id=yard["id"], theme="ocean", scope="all")
        assert (await d.call("chats.get", id=yard["id"]))["theme"] == "ocean"
        await d.fail("chats.theme", id=yard["id"], theme="sunset", scope="all")
        await d.call("chats.theme", id=yard["id"], theme="sunset", scope="me")
        g = await d.call("chats.get", id=yard["id"])
        assert g["theme"] == "ocean" and g["my_theme"] == "sunset", "своя тема — только у себя"
        assert (await b.call("chats.get", id=yard["id"]))["my_theme"] is None
        await d.fail("chats.theme", id=yard["id"], theme="<script>", scope="me")
        print("✓ оформление чата: для всех и для себя")

        # --- приложение TabChat.exe: локальный прокси со встроенным клиентом ---
        os.environ["TABCHAT_CLIENT_DATA"] = os.path.join(tmp, "client")
        appclient.LAUNCHER_PORT, appclient.FIRST_SERVER_PORT = free_port(), free_port()
        proxy = appclient.AppProxy(os.path.join(ROOT, "static"))
        await proxy.start()
        try:
            launcher = "http://127.0.0.1:%d" % appclient.LAUNCHER_PORT
            async with s.get(launcher + "/app/info") as r:
                ai = await r.json()
                assert ai["app"] and ai["server"] is None and ai["servers"] == []
            async with s.get(launcher + "/app/info", headers={"Host": "evil.example"}) as r:
                assert r.status == 403, "чужой адрес страницы (DNS rebinding) не пускаем"
            async with s.post(launcher + "/app/connect", json={"url": base}) as r:
                assert r.status == 403, "без заголовка приложения настройки не меняются"
            async with s.post(launcher + "/app/connect", json={"url": "127.0.0.1:1"},
                              headers={"X-TabChat-App": "1"}) as r:
                assert r.status == 400 and "не отвечает" in (await r.json())["error"]
            async with s.post(launcher + "/app/connect", json={"url": base + "/join/" + group["invite"]},
                              headers={"X-TabChat-App": "1"}) as r:
                res = await r.json()
                assert r.status == 200 and res["path"] == "/join/" + group["invite"], res
            origin = res["server"]["origin"]
            async with s.get(origin + "/app/info") as r:
                assert (await r.json())["server"]["id"] == sinfo["server_id"]
            async with s.get(origin + "/") as r:
                assert r.status == 200 and "importmap" in await r.text(), "клиент — из приложения"
            async with s.get(origin + "/api/info") as r:
                assert (await r.json())["server_id"] == sinfo["server_id"], "API — с сервера"
            frank = None
            async with s.post(origin + "/api/register", json={"username": "frank", "name": "Фрэнк", **creds()}) as r:
                frank = await r.json()
                assert r.status == 200, frank
            fc = Client(s, origin, frank["token"], frank["user"]["id"])
            await fc.connect()
            await fc.call("chats.join", code=group["invite"])
            await asyncio.sleep(0.1)
            assert any(e["ev"] == "chat" for e in fc.events), "события идут через прокси"
            async with s.ws_connect(origin.replace("http", "ws") + "/ws") as ws:
                await ws.send_json({"id": 1, "m": "auth", "p": {"token": "bad"}})
                await ws.receive()
                await ws.receive()
                assert ws.close_code == 4001, "код закрытия сервера доходит до приложения"
            # тот же сервер по другому адресу — тот же порт и то же хранилище
            async with s.post(launcher + "/app/connect", json={"url": base.replace("127.0.0.1", "localhost")},
                              headers={"X-TabChat-App": "1"}) as r:
                assert (await r.json())["server"]["origin"] == origin
        finally:
            await proxy.stop()
        print("✓ приложение: прокси к серверу, свой клиент, защита, одно хранилище на сервер")

        async with s.post(base + "/api/logout", headers={"Authorization": "Bearer " + bob["token"]}) as r:
            assert r.status == 200
        await asyncio.sleep(0.2)
        assert b.ws.closed
        print("✓ выход закрывает подключения")

    await runner.cleanup()

    # --- миграция старой базы ---
    old = os.path.join(tmp, "old.db")
    import sqlite3
    con = sqlite3.connect(old)
    from tabchat.db import SCHEMA
    con.executescript(SCHEMA)
    con.execute("INSERT INTO users(username,name,color,pw_hash,created_at) VALUES('legacy','L','#fff','x',0)")
    con.commit()
    con.close()
    db2 = DB(old)
    u = db2.user_by_username("legacy")
    assert u["kdf"] == "legacy" and u["key_ecdh"] is None
    assert db2.val("PRAGMA user_version") == 5
    DB(old)  # повторное открытие — миграция не ломается
    print("✓ миграция старой базы")
    db.c.close()
    db2.c.close()
    shutil.rmtree(tmp, ignore_errors=True)
    print("\nВсе проверки пройдены")


if __name__ == "__main__":
    asyncio.run(main())
