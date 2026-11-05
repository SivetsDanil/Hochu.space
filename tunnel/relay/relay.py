#!/usr/bin/env python3
"""
TabTunnel relay — публичная половина туннеля (то, что у ngrok и tuna работает на их серверах).

Ставится на любой сервер с публичным IP. Клиент TabTunnel изнутри домашней сети подключается
к нему по WebSocket и держит это соединение открытым. Когда из интернета приходит запрос,
relay открывает внутри соединения новый «поток» и гоняет по нему байты в обе стороны.
Клиент на другом конце соединяет поток с локальным сервером (например, с чатом на :8080).

Зависимостей нет — только стандартная библиотека Python 3.8+.

    python3 relay.py --token СЕКРЕТ --port 7000
        один туннель на весь сервер: всё, что пришло на этот адрес, уходит единственному клиенту

    python3 relay.py --token СЕКРЕТ --port 7000 --domain 1-2-3-4.sslip.io
        много туннелей: у каждого клиента своё имя → https://имя.1-2-3-4.sslip.io

HTTPS удобнее всего отдать Caddy (см. install.sh) — он сам получает сертификаты Let's Encrypt.
"""
import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import ssl
import struct
import sys
import time
from urllib.parse import parse_qs, urlsplit

PROTOCOL = 1
# типы кадров внутри туннеля: [1 байт тип][4 байта id потока][данные]
OPEN, DATA, CLOSE, WINDOW, EOF = 1, 2, 3, 4, 5
WINDOW_SIZE = 256 * 1024        # сколько байт можно отправить в поток без подтверждения
CHUNK = 32 * 1024
MAX_HEAD = 64 * 1024
MAX_WS_MESSAGE = 4 * 1024 * 1024
MAX_STREAMS = 1024
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")

log = logging.getLogger("relay")

PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TabTunnel</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1621;
color:#e8eef4;font:16px system-ui,sans-serif}}div{{text-align:center;padding:24px}}b{{font-size:22px}}p{{color:#8a9bab}}</style>
<div><b>{title}</b><p>{text}</p></div>"""


def frame(kind, sid, payload=b""):
    return struct.pack("!BI", kind, sid) + payload


def unmask(data, mask):
    n = len(data)
    if not n:
        return data
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "little") ^ int.from_bytes(key, "little")).to_bytes(n, "little")


def close_writer(writer):
    try:
        writer.close()
    except Exception:
        pass


class Head:
    """Заголовок HTTP-запроса — нужен, только чтобы понять, куда направить соединение."""

    def __init__(self, raw):
        self.raw = raw
        lines = raw.decode("latin-1").split("\r\n")
        parts = lines[0].split(" ")
        self.method = parts[0] if parts else ""
        self.target = parts[1] if len(parts) > 1 else "/"
        self.headers = {}
        for line in lines[1:]:
            k, sep, v = line.partition(":")
            if sep:
                self.headers[k.strip().lower()] = v.strip()
        url = urlsplit(self.target)
        self.path = url.path
        self.query = parse_qs(url.query)

    @property
    def is_upgrade(self):
        return bool(self.headers.get("upgrade")) and "upgrade" in self.headers.get("connection", "").lower()

    def with_connection_close(self):
        """Тот же запрос, но с Connection: close — чтобы соединение не переиспользовали для другого туннеля."""
        lines = self.raw.decode("latin-1").split("\r\n")
        kept = [lines[0]] + [l for l in lines[1:] if l and l.split(":", 1)[0].strip().lower()
                             not in ("connection", "keep-alive", "proxy-connection")]
        return ("\r\n".join(kept + ["Connection: close"]) + "\r\n\r\n").encode("latin-1")

    @property
    def host(self):
        host = self.headers.get("host", "").lower()
        if host.startswith("["):
            return host[1:host.find("]")]
        return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


async def respond(writer, status, title, text, extra=""):
    body = PAGE.format(title=title, text=text).encode()
    writer.write(("HTTP/1.1 %s\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %d\r\n"
                  "Cache-Control: no-store\r\nConnection: close\r\n%s\r\n" % (status, len(body), extra)).encode() + body)
    try:
        await writer.drain()
    finally:
        close_writer(writer)


async def respond_plain(writer, status, text):
    body = text.encode()
    writer.write(("HTTP/1.1 %s\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
                  % (status, len(body))).encode() + body)
    try:
        await writer.drain()
    finally:
        close_writer(writer)


class WebSocket:
    """Минимальный WebSocket-сервер (RFC 6455): ровно столько, сколько нужно для канала управления."""

    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.lock = asyncio.Lock()
        self.last_seen = time.monotonic()

    async def send(self, opcode, payload):
        n = len(payload)
        if n < 126:
            hdr = struct.pack("!BB", 0x80 | opcode, n)
        elif n < 65536:
            hdr = struct.pack("!BBH", 0x80 | opcode, 126, n)
        else:
            hdr = struct.pack("!BBQ", 0x80 | opcode, 127, n)
        async with self.lock:
            self.writer.write(hdr + payload)
            await self.writer.drain()

    async def send_json(self, obj):
        await self.send(0x1, json.dumps(obj, ensure_ascii=False).encode())

    async def recv(self):
        """Целое сообщение (opcode, payload). Пинги отвечаем сами, close — исключение."""
        message, msg_op = b"", None
        while True:
            b1, b2 = await self.reader.readexactly(2)
            fin, op, n = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", await self.reader.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", await self.reader.readexactly(8))[0]
            if n > MAX_WS_MESSAGE:
                raise ConnectionError("слишком большой кадр")
            mask = await self.reader.readexactly(4) if b2 & 0x80 else None
            data = await self.reader.readexactly(n)
            if mask:
                data = unmask(data, mask)
            self.last_seen = time.monotonic()
            if op == 0x9:
                await self.send(0xA, data)
                continue
            if op == 0xA:
                continue
            if op == 0x8:
                try:
                    await self.send(0x8, data[:2])
                except Exception:
                    pass
                raise ConnectionError("клиент закрыл соединение")
            if op in (0x1, 0x2):
                msg_op, message = op, data
            elif op == 0x0:
                message += data
            if len(message) > MAX_WS_MESSAGE:
                raise ConnectionError("слишком большое сообщение")
            if fin:
                return msg_op, message


class Stream:
    """Одно публичное соединение, проброшенное в туннель."""

    def __init__(self, session, sid, writer):
        self.session, self.sid, self.writer = session, sid, writer
        self.credit = WINDOW_SIZE
        self.credit_event = asyncio.Event()
        self.queue = asyncio.Queue()
        self.read_done = False
        self.write_done = False
        self.dead = False
        self.writer_task = asyncio.ensure_future(self._write_loop())

    async def _write_loop(self):
        """Данные от клиента → в сокет посетителя; после записи возвращаем «окно»."""
        try:
            while True:
                data = await self.queue.get()
                if data is None:            # клиент больше ничего не пришлёт
                    try:
                        if self.writer.can_write_eof():
                            self.writer.write_eof()
                    except (OSError, RuntimeError):
                        pass
                    self.write_done = True
                    self._maybe_finish()
                    return
                self.writer.write(data)
                await self.writer.drain()
                await self.session.send(frame(WINDOW, self.sid, struct.pack("!I", len(data))))
        except (ConnectionError, OSError):
            self.abort(notify=True)
        except asyncio.CancelledError:
            pass

    async def send(self, data):
        """Данные посетителя → клиенту, не больше выданного окна."""
        view = memoryview(data)
        while view and not self.dead:
            while self.credit <= 0 and not self.dead:
                self.credit_event.clear()
                await self.credit_event.wait()
            if self.dead:
                return
            n = min(len(view), self.credit, CHUNK)
            self.credit -= n
            await self.session.send(frame(DATA, self.sid, bytes(view[:n])))
            self.session.relay.stats["tx"] += n
            view = view[n:]

    def add_credit(self, n):
        self.credit += n
        self.credit_event.set()

    def _maybe_finish(self):
        if self.read_done and self.write_done:
            self.abort(notify=False)

    def abort(self, notify):
        if self.dead:
            return
        self.dead = True
        self.credit_event.set()
        self.session.streams.pop(self.sid, None)
        close_writer(self.writer)
        if not self.writer_task.done():
            self.writer_task.cancel()
        if notify:
            asyncio.ensure_future(self.session.send_quiet(frame(CLOSE, self.sid)))


class Session:
    """Подключённый клиент TabTunnel."""

    def __init__(self, relay, ws, name, client_id, peer):
        self.relay, self.ws, self.name, self.client_id, self.peer = relay, ws, name, client_id, peer
        self.streams = {}
        self.next_sid = 1
        self.closed = False
        self.started = time.time()

    async def send(self, data):
        if self.closed:
            raise ConnectionError("сессия закрыта")
        await self.ws.send(0x2, data)

    async def send_quiet(self, data):
        try:
            await self.send(data)
        except Exception:
            pass

    def open_stream(self, writer):
        sid = self.next_sid
        self.next_sid += 1
        st = Stream(self, sid, writer)
        self.streams[sid] = st
        return st

    async def run(self):
        pinger = asyncio.ensure_future(self._ping())
        try:
            while True:
                op, msg = await self.ws.recv()
                if op != 0x2 or len(msg) < 5:
                    continue                 # текстовые сообщения после приветствия пока не нужны
                kind, sid = struct.unpack("!BI", msg[:5])
                st = self.streams.get(sid)
                if st is None:
                    continue
                if kind == DATA:
                    self.relay.stats["rx"] += len(msg) - 5
                    st.queue.put_nowait(msg[5:])
                elif kind == WINDOW and len(msg) >= 9:
                    st.add_credit(struct.unpack("!I", msg[5:9])[0])
                elif kind == EOF:
                    st.queue.put_nowait(None)
                elif kind == CLOSE:
                    st.abort(notify=False)
        finally:
            pinger.cancel()
            self.close()

    async def _ping(self):
        while True:
            await asyncio.sleep(25)
            if time.monotonic() - self.ws.last_seen > 75:
                log.info("туннель %s молчит — отключаю", self.name)
                close_writer(self.ws.writer)
                return
            try:
                await self.ws.send(0x9, b"p")
            except Exception:
                return

    def close(self):
        if self.closed:
            return
        self.closed = True
        for st in list(self.streams.values()):
            st.abort(notify=False)
        close_writer(self.ws.writer)


class Relay:
    def __init__(self, args):
        self.args = args
        self.tokens = [t for t in args.token if t]
        self.domain = (args.domain or "").lower().strip(".") or None
        self.sessions = {}          # name -> Session
        self.stats = {"rx": 0, "tx": 0, "conns": 0}

    # ---------- маршрутизация ----------
    def session_for_host(self, host):
        if self.domain:
            if host.endswith("." + self.domain):
                return self.sessions.get(host[: -len(self.domain) - 1])
            return None
        return next(iter(self.sessions.values()), None)

    def public_url(self, name, head):
        if self.domain:
            port = ":%d" % self.args.url_port if self.args.url_port else ""
            return "%s://%s.%s%s" % (self.args.scheme, name, self.domain, port)
        if self.args.public_url:
            return self.args.public_url.rstrip("/")
        proto = head.headers.get("x-forwarded-proto") or ("https" if self.args.tls_cert else "http")
        return "%s://%s" % (proto, head.headers.get("x-forwarded-host") or head.headers.get("host", ""))

    def is_relay_host(self, host):
        """Свой адрес relay (а не адрес чьего-то туннеля)."""
        return not self.domain or not host.endswith("." + self.domain)

    def turn_info(self):
        if not (self.args.turn_secret and self.args.turn_url):
            return None
        return {"urls": self.args.turn_url, "secret": self.args.turn_secret}

    # ---------- входящие соединения ----------
    async def on_connection(self, reader, writer):
        peer = writer.get_extra_info("peername")
        peer = peer[0] if peer else "?"
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 20)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError, OSError):
            close_writer(writer)
            return
        try:
            head = Head(raw)
        except Exception:
            close_writer(writer)
            return
        host = head.host
        try:
            if self.is_relay_host(host) and head.path == "/_tunnel" and \
                    head.headers.get("upgrade", "").lower() == "websocket":
                await self.handle_control(head, reader, writer, peer)
            elif self.is_relay_host(host) and head.path == "/_tunnel/ask":
                await self.handle_ask(head, writer)
            elif self.is_relay_host(host) and head.path == "/_tunnel/health":
                await respond_plain(writer, "200 OK", "ok %d" % len(self.sessions))
            else:
                await self.handle_public(head, reader, writer, peer)
        except (ConnectionError, OSError, asyncio.IncompleteReadError, asyncio.TimeoutError):
            close_writer(writer)
        except Exception:
            log.exception("ошибка обработки соединения")
            close_writer(writer)

    async def handle_ask(self, head, writer):
        """Caddy спрашивает, можно ли выпускать сертификат для этого имени (on-demand TLS)."""
        domain = (head.query.get("domain") or [""])[0].lower()
        ok = False
        if self.domain and domain == self.domain:
            ok = True
        elif self.domain and domain.endswith("." + self.domain):
            ok = domain[: -len(self.domain) - 1] in self.sessions
        elif not self.domain:
            ok = True
        await respond_plain(writer, "200 OK" if ok else "404 Not Found", "ok" if ok else "unknown")

    async def handle_public(self, head, reader, writer, peer):
        session = self.session_for_host(head.host)
        if session is None or session.closed:
            if self.domain and head.host in (self.domain, "www." + self.domain):
                await respond(writer, "200 OK", "TabTunnel relay работает",
                              "Подключено туннелей: %d" % len(self.sessions))
            else:
                await respond(writer, "502 Bad Gateway", "Туннель не подключён",
                              "Программа на той стороне сейчас не в сети. Попробуйте чуть позже.")
            return
        if len(session.streams) >= MAX_STREAMS:
            await respond(writer, "503 Service Unavailable", "Слишком много соединений", "Попробуйте позже.")
            return
        self.stats["conns"] += 1
        st = session.open_stream(writer)
        info = {"peer": head.headers.get("x-forwarded-for", peer).split(",")[0].strip(), "host": head.host}
        # с несколькими туннелями одно TCP-соединение должно обслуживать только один из них:
        # прокси (Caddy) и клиенты иначе могут отправить по нему запрос к другому имени
        first = head.with_connection_close() if self.domain and not head.is_upgrade else head.raw
        try:
            await session.send(frame(OPEN, st.sid, json.dumps(info).encode()))
            await st.send(first)
            while not st.dead:
                data = await reader.read(CHUNK)
                if not data:
                    break
                await st.send(data)
            if not st.dead:
                await session.send(frame(EOF, st.sid))
                st.read_done = True
                st._maybe_finish()
        except (ConnectionError, OSError):
            st.abort(notify=True)

    async def handle_control(self, head, reader, writer, peer):
        key = head.headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1(key.encode() + WS_GUID).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
        await writer.drain()
        ws = WebSocket(reader, writer)
        op, msg = await asyncio.wait_for(ws.recv(), 20)
        try:
            hello = json.loads(msg.decode())
        except ValueError:
            hello = {}
        token = str(hello.get("token") or "")
        if not any(hmac.compare_digest(token, t) for t in self.tokens):
            log.warning("неверный ключ от %s", peer)
            await asyncio.sleep(1)
            await ws.send_json({"type": "error", "fatal": True, "message": "Неверный ключ подключения"})
            close_writer(writer)
            return
        client_id = str(hello.get("client") or secrets.token_hex(8))[:64]
        name = str(hello.get("name") or "").lower().strip()
        if self.domain:
            if not name:
                name = secrets.token_hex(3)
            if not NAME_RE.match(name):
                await ws.send_json({"type": "error", "fatal": True,
                                    "message": "Имя туннеля: латиница, цифры и дефис, до 32 символов"})
                close_writer(writer)
                return
            other = self.sessions.get(name)
            if other and not other.closed and other.client_id != client_id:
                await ws.send_json({"type": "error", "fatal": True, "message": "Имя «%s» уже занято" % name})
                close_writer(writer)
                return
        else:
            name = "main"
        old = self.sessions.get(name)
        if old:
            old.close()                       # переподключение того же клиента или новый владелец адреса
        session = Session(self, ws, name, client_id, peer)
        self.sessions[name] = session
        url = self.public_url(name, head)
        log.info("туннель %s подключён с %s → %s", name, peer, url)
        try:
            await ws.send_json({"type": "welcome", "v": PROTOCOL, "name": name, "url": url, "turn": self.turn_info()})
            await session.run()
        finally:
            session.close()
            if self.sessions.get(name) is session:
                del self.sessions[name]
            log.info("туннель %s отключился", name)


async def main_async(args):
    relay = Relay(args)
    ctx = None
    if args.tls_cert:
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(args.tls_cert, args.tls_key)
    server = await asyncio.start_server(relay.on_connection, args.listen, args.port, ssl=ctx, limit=MAX_HEAD)
    where = ", ".join(str(s.getsockname()[:2]) for s in server.sockets)
    mode = ("много туннелей: <имя>.%s" % relay.domain) if relay.domain else "один туннель"
    log.info("TabTunnel relay слушает %s (%s)", where, mode)
    async with server:
        await server.serve_forever()


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="TabTunnel relay — публичная часть туннеля")
    p.add_argument("--listen", default="0.0.0.0", help="адрес (за Caddy — 127.0.0.1)")
    p.add_argument("--port", type=int, default=7000)
    p.add_argument("--token", action="append", default=[], help="ключ доступа для клиентов (можно несколько)")
    p.add_argument("--token-file", help="файл с ключами, по одному в строке")
    p.add_argument("--domain", help="домен для режима «много туннелей»: имя.домен")
    p.add_argument("--scheme", default="https", help="схема публичных ссылок в режиме домена")
    p.add_argument("--url-port", type=int, help="порт в публичных ссылках (если не 80/443, например при проверке у себя)")
    p.add_argument("--public-url", help="публичный адрес в режиме одного туннеля")
    p.add_argument("--tls-cert", help="сертификат, если relay сам принимает HTTPS (без Caddy)")
    p.add_argument("--tls-key")
    p.add_argument("--turn-url", action="append", default=[], help="TURN для звонков, напр. turn:1.2.3.4:3478")
    p.add_argument("--turn-secret", help="static-auth-secret из coturn")
    p.add_argument("--turn-secret-file", help="файл с секретом TURN (чтобы не светить его в списке процессов)")
    args = p.parse_args(argv)
    if args.turn_secret_file:
        with open(args.turn_secret_file, encoding="utf-8") as f:
            args.turn_secret = f.readline().strip()
    if args.token_file:
        with open(args.token_file, encoding="utf-8") as f:
            args.token += [line.strip() for line in f if line.strip() and not line.startswith("#")]
    if not args.token:
        p.error("нужен хотя бы один --token или --token-file")
    return args


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    args = parse_args()
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
