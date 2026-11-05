"""Приложение TabChat.exe: свой веб-клиент внутри exe и локальный прокси к серверу.

Окно приложения — Edge (или Chrome) в режиме приложения, без адресной строки, открытое на
http://127.0.0.1:ПОРТ. Страницы и код клиента отдаются из самого exe, а /api, /ws, /media и /download
проксируются на выбранный сервер. Поэтому:
  • сервер или туннель по дороге не могут подменить код, которым шифруется переписка;
  • страница считается безопасной (localhost) — микрофон, камера и шифрование работают даже с сервером
    без https, например по http://192.168.1.10:8080 в домашней сети.

У каждого сервера свой локальный порт, а значит своё хранилище в браузере: аккаунты и ключи разных серверов
не смешиваются. Сервер узнаётся по постоянному id, поэтому смена его адреса ничего не ломает.
На порту LAUNCHER_PORT — экран выбора сервера.
"""
import asyncio
import ipaddress
import json
import logging
import os
import re
import time
from urllib.parse import urlsplit

import aiohttp
from aiohttp import WSMsgType, web

from .assets import Assets
from .version import PROTOCOL, VERSION

LAUNCHER_PORT = 47800
FIRST_SERVER_PORT = 47801
MIN_SERVER_PROTOCOL = 1          # сервер старее этого приложение уже не понимает
LOCAL_SERVER_PORTS = range(8080, 8086)
# заголовки одного соединения (hop-by-hop) — их не пересылаем
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers",
       "transfer-encoding", "upgrade", "host", "origin", "referer", "cookie", "set-cookie"}

log = logging.getLogger("tabchat.app")


class ServerError(Exception):
    pass


def data_dir():
    """Настройки приложения: %APPDATA%\\TabChat (для проверок можно задать свою папку --data)."""
    if os.environ.get("TABCHAT_CLIENT_DATA"):
        return os.environ["TABCHAT_CLIENT_DATA"]
    base = os.environ.get("APPDATA") or os.path.expanduser("~/.config")
    return os.path.join(base, "TabChat")


def config_path():
    return os.path.join(data_dir(), "client.json")


def load_config():
    try:
        with open(config_path(), encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    if not isinstance(cfg.get("servers"), list):
        cfg["servers"] = []
    return cfg


def save_config(cfg):
    os.makedirs(data_dir(), exist_ok=True)
    path = config_path()
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def is_private_host(host):
    if host in ("localhost",):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback


def parse_link(text):
    """Ссылка на сервер или приглашение → (адрес сервера, путь, который открыть).
    Без схемы: для домашней сети и localhost — http, для интернета — https."""
    text = (text or "").strip()
    if not text:
        raise ServerError("Вставьте ссылку на сервер")
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", text):
        host = re.split(r"[:/]", text, 1)[0]
        text = ("http://" if is_private_host(host) else "https://") + text
    u = urlsplit(text)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ServerError("Это не похоже на ссылку на сервер TabChat")
    path = u.path if re.match(r"^/join/[A-Za-z0-9_-]+$", u.path or "") else "/"
    return "%s://%s" % (u.scheme, u.netloc), path


def public(srv):
    return {"id": srv["id"], "url": srv["url"], "host": urlsplit(srv["url"]).netloc,
            "origin": "http://127.0.0.1:%d" % srv["port"], "protocol": srv.get("protocol"),
            "public_url": srv.get("public_url")}


def json_error(text, status=400):
    return web.json_response({"error": text}, status=status)


def local_port(request):
    sock = request.transport.get_extra_info("sockname") if request.transport else None
    return sock[1] if sock else None


class AppProxy:
    def __init__(self, static_dir):
        self.assets = Assets(static_dir)
        self.cfg = load_config()
        self.runner = None
        self.sites = {}
        self.session = None
        self.alive = 0                     # открытые окна приложения (каждое держит /app/alive)
        self.seen_window = False
        self.last_alive = time.monotonic()

    # ---------- серверы ----------
    def server_for_port(self, port):
        return next((s for s in self.cfg["servers"] if s["port"] == port), None)

    def server_by_id(self, sid):
        return next((s for s in self.cfg["servers"] if s["id"] == sid), None)

    def last_server(self):
        return self.server_by_id(self.cfg.get("last")) or (self.cfg["servers"][0] if self.cfg["servers"] else None)

    async def probe(self, base):
        """Проверяем, что по адресу сервер TabChat и что мы друг друга поймём."""
        try:
            async with self.session.get(base + "/api/info", timeout=aiohttp.ClientTimeout(total=20)) as r:
                if r.status == 404:
                    raise ServerError("По этому адресу нет сервера TabChat — или он устарел и его нужно обновить")
                if r.status != 200:
                    raise ServerError("Сервер ответил ошибкой %d" % r.status)
                info = await r.json(content_type=None)
        except aiohttp.ClientConnectorCertificateError:
            raise ServerError("Сертификат сервера не подтверждён. В домашней сети подключайтесь по адресу "
                              "http://IP-сервера:8080 — приложение работает и без https")
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            raise ServerError("Сервер не отвечает. Проверьте ссылку и что TabChat Server запущен")
        except ValueError:
            raise ServerError("По этому адресу не сервер TabChat")
        if not isinstance(info, dict) or info.get("app") != "TabChat" or not info.get("server_id"):
            raise ServerError("По этому адресу не сервер TabChat")
        proto = info.get("protocol") or 0
        if proto < MIN_SERVER_PROTOCOL:
            raise ServerError("Сервер устарел — попросите его владельца обновить TabChat Server")
        if proto > PROTOCOL:
            raise ServerError("Приложение устарело для этого сервера. Скачайте новое: %s/download/windows" % base)
        return info

    async def connect(self, link):
        """Подключить сервер по ссылке: запомнить его и открыть для него локальный порт."""
        base, path = parse_link(link)
        info = await self.probe(base)
        srv = self.server_by_id(info["server_id"])
        if srv:
            srv["url"] = base                  # тот же сервер, возможно по новому адресу
        else:
            port = max([s["port"] for s in self.cfg["servers"]], default=FIRST_SERVER_PORT - 1) + 1
            srv = {"id": info["server_id"], "url": base, "port": port}
            self.cfg["servers"].append(srv)
        srv.update(protocol=info.get("protocol"), public_url=info.get("public_url"))
        self.cfg["last"] = srv["id"]
        save_config(self.cfg)
        await self.listen(srv["port"])
        log.info("подключён сервер %s (%s) на порту %d", base, srv["id"], srv["port"])
        return srv, path

    async def find_local(self):
        """Сервер на этом же компьютере (TabChat Server рядом) — чтобы предложить его одной кнопкой."""
        async def check(port):
            try:
                async with self.session.get("http://127.0.0.1:%d/api/info" % port,
                                            timeout=aiohttp.ClientTimeout(total=0.6)) as r:
                    info = await r.json(content_type=None) if r.status == 200 else None
                    return "http://localhost:%d" % port if info and info.get("app") == "TabChat" else None
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
                return None
        found = await asyncio.gather(*(check(p) for p in LOCAL_SERVER_PORTS))
        return next((u for u in found if u), None)

    # ---------- запуск ----------
    async def start(self):
        """Поднимает прокси. OSError — порт экрана выбора занят (обычно — приложение уже запущено)."""
        self.session = aiohttp.ClientSession(auto_decompress=False, cookie_jar=aiohttp.DummyCookieJar(),
                                             timeout=aiohttp.ClientTimeout(total=None, sock_connect=20))
        app = web.Application(middlewares=[self.guard])
        self.assets.add_routes(app)
        app.router.add_get("/app/info", self.h_info)
        app.router.add_post("/app/connect", self.h_connect)
        app.router.add_post("/app/forget", self.h_forget)
        app.router.add_get("/app/alive", self.h_alive)
        app.router.add_get("/ws", self.h_ws)
        for prefix in ("/api/", "/media/", "/download/"):
            app.router.add_route("*", prefix + "{tail:.*}", self.h_proxy)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        try:
            await self.listen(LAUNCHER_PORT)
        except OSError:
            await self.runner.cleanup()
            await self.session.close()
            raise
        for s in self.cfg["servers"]:
            try:
                await self.listen(s["port"])
            except OSError as e:
                log.warning("порт %d для %s занят: %s", s["port"], s["url"], e)

    async def listen(self, port):
        if port in self.sites:
            return
        site = web.TCPSite(self.runner, "127.0.0.1", port)
        await site.start()
        self.sites[port] = site

    async def stop(self):
        if self.runner:
            await self.runner.cleanup()
        if self.session:
            await self.session.close()

    # ---------- защита ----------
    @web.middleware
    async def guard(self, request, handler):
        # страница должна быть именно нашей (против DNS rebinding), а менять настройки — только наша страница
        host = (request.headers.get("Host") or "").rsplit(":", 1)[0]
        if host not in ("127.0.0.1", "localhost"):
            return json_error("forbidden", 403)
        if request.path.startswith("/app/") and request.method == "POST" and request.headers.get("X-TabChat-App") != "1":
            return json_error("forbidden", 403)
        resp = await handler(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        return resp

    # ---------- /app ----------
    async def h_info(self, request):
        srv = self.server_for_port(local_port(request))
        return web.json_response({
            "app": True, "version": VERSION, "protocol": PROTOCOL,
            "server": public(srv) if srv else None,
            "servers": [public(s) for s in self.cfg["servers"]],
            "last": self.cfg.get("last"),
            "launcher": "http://127.0.0.1:%d" % LAUNCHER_PORT,
            "local": None if srv else await self.find_local(),
        })

    async def h_connect(self, request):
        try:
            data = await request.json()
            srv, path = await self.connect(str(data.get("url") or ""))
        except ServerError as e:
            return json_error(str(e))
        except (ValueError, OSError) as e:
            return json_error("Не получилось подключиться: %s" % e)
        return web.json_response({"server": public(srv), "path": path})

    async def h_forget(self, request):
        data = await request.json()
        self.cfg["servers"] = [s for s in self.cfg["servers"] if s["id"] != data.get("id")]
        save_config(self.cfg)
        return web.json_response({"ok": True})

    async def h_alive(self, request):
        """Каждое открытое окно держит это соединение: когда окон не осталось, приложение завершается."""
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        self.alive += 1
        self.seen_window = True
        try:
            async for _ in ws:
                pass
        finally:
            self.alive -= 1
            self.last_alive = time.monotonic()
        return ws

    # ---------- прокси к серверу ----------
    async def h_proxy(self, request):
        srv = self.server_for_port(local_port(request))
        if not srv:
            return json_error("Сервер не выбран", 404)
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
        # тело (файлы до 200 МБ) идёт на сервер потоком: браузер шлёт его не быстрее, чем уходит дальше,
        # поэтому полоска загрузки показывает настоящий прогресс
        data = request.content.iter_chunked(64 * 1024) if request.body_exists else None
        resp = None
        try:
            async with self.session.request(request.method, srv["url"] + request.raw_path, headers=headers,
                                            data=data, allow_redirects=False) as up:
                resp = web.StreamResponse(status=up.status, reason=up.reason)
                for k, v in up.headers.items():
                    if k.lower() not in HOP:
                        resp.headers.add(k, v)
                await resp.prepare(request)
                async for chunk in up.content.iter_chunked(64 * 1024):
                    await resp.write(chunk)
                await resp.write_eof()
                return resp
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
            if resp is not None and resp.prepared:
                return resp                                  # браузер или сервер оборвали уже начатый ответ
            log.info("сервер %s недоступен: %r", srv["url"], e)
            return json_error("Сервер недоступен", 502)

    async def h_ws(self, request):
        srv = self.server_for_port(local_port(request))
        ws = web.WebSocketResponse(max_msg_size=4 * 1024 * 1024)
        await ws.prepare(request)
        if not srv:
            await ws.close(code=1011)
            return ws
        url = re.sub(r"^http", "ws", srv["url"]) + "/ws"
        headers = {"User-Agent": request.headers.get("User-Agent", "TabChat")}
        try:
            async with self.session.ws_connect(url, headers=headers, heartbeat=25, max_msg_size=4 * 1024 * 1024,
                                               timeout=aiohttp.ClientWSTimeout(ws_close=5)) as up:
                async def to_server():
                    async for msg in ws:
                        if msg.type == WSMsgType.TEXT:
                            await up.send_str(msg.data)
                        elif msg.type == WSMsgType.BINARY:
                            await up.send_bytes(msg.data)

                async def to_browser():
                    async for msg in up:
                        if msg.type == WSMsgType.TEXT:
                            await ws.send_str(msg.data)
                        elif msg.type == WSMsgType.BINARY:
                            await ws.send_bytes(msg.data)

                tasks = [asyncio.ensure_future(to_server()), asyncio.ensure_future(to_browser())]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in tasks:
                    t.cancel()
                # код закрытия сервера (4001 — сессия отозвана) важен клиенту: передаём его как есть
                code = up.close_code if up.closed and up.close_code else 1000
                await ws.close(code=code if code == 1000 or 3000 <= code < 5000 else 1011)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
            log.info("WebSocket к %s: %r", srv["url"], e)
            await ws.close(code=1011)                        # клиент переподключится сам
        return ws
