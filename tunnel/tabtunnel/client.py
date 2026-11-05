"""Клиент TabTunnel на aiohttp.

    client = TunnelClient("tabtunnel://секрет@relay.example.com", port=8080)
    await client.run()          # держит туннель, переподключается сам

Статус и ссылка — в client.status / client.url, события — через колбэки.
"""
import asyncio
import json
import secrets
import struct
import time

import aiohttp

from .protocol import CHUNK, CLOSE, DATA, EOF, OPEN, PROTOCOL, WINDOW, WINDOW_SIZE, frame, parse_frame, parse_key

BAD_GATEWAY = (
    "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n"
    "<!doctype html><meta charset=utf-8><title>TabTunnel</title>"
    "<body style='margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1621;color:#e8eef4;"
    "font:16px system-ui'><div style='text-align:center'><b style='font-size:22px'>Сервер не отвечает</b>"
    "<p style='color:#8a9bab'>Туннель работает, но программа на компьютере не запущена (порт {port}).</p></div>"
).encode()


class FatalTunnelError(Exception):
    """Ошибка, после которой нет смысла переподключаться (неверный ключ, занятое имя)."""


class _Stream:
    def __init__(self, client, sid):
        self.client, self.sid = client, sid
        self.credit = WINDOW_SIZE
        self.credit_event = asyncio.Event()
        self.queue = asyncio.Queue()
        self.writer = None
        self.read_done = False
        self.write_done = False
        self.dead = False
        self.first_chunk = True
        self.task = asyncio.ensure_future(self._run())

    async def _run(self):
        c = self.client
        try:
            reader, self.writer = await asyncio.wait_for(asyncio.open_connection(c.host, c.port), 10)
        except (OSError, asyncio.TimeoutError):
            # локальный сервер не запущен — отдаём посетителю понятную страницу
            await self._send(BAD_GATEWAY.replace(b"{port}", str(c.port).encode()))
            await c._send(frame(EOF, self.sid))
            self.abort(notify=False)
            return
        pump_out = asyncio.ensure_future(self._write_loop())
        try:
            while not self.dead:
                data = await reader.read(CHUNK)
                if not data:
                    break
                await self._send(data)
            if not self.dead:
                await c._send(frame(EOF, self.sid))
                self.read_done = True
                self._maybe_finish()
        except (ConnectionError, OSError):
            self.abort(notify=True)
        finally:
            if self.dead and not pump_out.done():
                pump_out.cancel()

    async def _write_loop(self):
        """Данные посетителя (от relay) → в локальный сервер."""
        try:
            while True:
                data = await self.queue.get()
                if data is None:
                    try:
                        if self.writer.can_write_eof():
                            self.writer.write_eof()
                    except (OSError, RuntimeError):
                        pass
                    self.write_done = True
                    self._maybe_finish()
                    return
                if self.first_chunk:
                    self.first_chunk = False
                    self.client._log_request(data)
                self.writer.write(data)
                await self.writer.drain()
                await self.client._send(frame(WINDOW, self.sid, struct.pack("!I", len(data))))
        except (ConnectionError, OSError):
            self.abort(notify=True)
        except asyncio.CancelledError:
            pass

    async def _send(self, data):
        view = memoryview(data)
        while view and not self.dead:
            while self.credit <= 0 and not self.dead:
                self.credit_event.clear()
                await self.credit_event.wait()
            if self.dead:
                return
            n = min(len(view), self.credit, CHUNK)
            self.credit -= n
            await self.client._send(frame(DATA, self.sid, bytes(view[:n])))
            self.client.stats["tx"] += n
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
        self.client.streams.pop(self.sid, None)
        self.client.stats["active"] = len(self.client.streams)
        self.client._changed()
        if self.writer is not None:
            try:
                self.writer.close()
            except Exception:
                pass
        if not self.task.done() and asyncio.current_task() is not self.task:
            self.task.cancel()
        if notify:
            asyncio.ensure_future(self.client._send_quiet(frame(CLOSE, self.sid)))


class TunnelClient:
    def __init__(self, key, port, host="127.0.0.1", name=None, client_id=None,
                 on_status=None, on_request=None, ssl=None):
        self.key = parse_key(key, name)
        self.port, self.host = int(port), host
        self.client_id = client_id or secrets.token_hex(8)
        self.on_status, self.on_request = on_status, on_request
        self.ssl = ssl
        self.status = "idle"          # idle | connecting | online | offline | error
        self.url = None
        self.error = None
        self.turn = None
        self.name = None
        self.streams = {}
        self.stats = {"active": 0, "total": 0, "rx": 0, "tx": 0}
        self._ws = None
        self._lock = asyncio.Lock()
        self._stop = False
        self._last_change = 0

    # ---------- публичное ----------
    async def run(self):
        delay = 1
        async with aiohttp.ClientSession() as http:
            while not self._stop:
                self._set("connecting")
                try:
                    await self._connect(http)
                    # были в сети и потеряли связь — переподключаемся быстро
                    delay = 1
                    self._set("offline", "связь с relay потеряна")
                except FatalTunnelError as e:
                    self._set("error", str(e))
                    return
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # сеть, relay перезапускается и т. п.
                    self._set("offline", self._describe(e))
                finally:
                    self._drop_streams()
                if self._stop:
                    break
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)
        self._set("idle")

    def stop(self):
        self._stop = True
        if self._ws is not None:
            asyncio.ensure_future(self._ws.close())

    # ---------- внутреннее ----------
    @staticmethod
    def _describe(e):
        if isinstance(e, aiohttp.WSServerHandshakeError):
            return "relay ответил %s — проверьте адрес" % e.status
        if isinstance(e, (aiohttp.ClientConnectorError, OSError)):
            return "relay недоступен"
        if isinstance(e, asyncio.TimeoutError):
            return "relay не отвечает"
        return str(e) or e.__class__.__name__

    async def _connect(self, http):
        async with http.ws_connect(self.key.ws_url, heartbeat=25, max_msg_size=8 * 1024 * 1024,
                                   ssl=self.ssl, timeout=aiohttp.ClientWSTimeout(ws_close=10)
                                   if hasattr(aiohttp, "ClientWSTimeout") else 10) as ws:
            self._ws = ws
            await ws.send_json({"type": "hello", "v": PROTOCOL, "token": self.key.token,
                                "name": self.key.name, "client": self.client_id})
            msg = await ws.receive(timeout=20)
            if msg.type != aiohttp.WSMsgType.TEXT:
                raise ConnectionError("relay закрыл соединение")
            welcome = json.loads(msg.data)
            if welcome.get("type") == "error":
                if welcome.get("fatal"):
                    raise FatalTunnelError(welcome.get("message") or "relay отказал")
                raise ConnectionError(welcome.get("message") or "relay отказал")
            self.url = welcome.get("url")
            self.name = welcome.get("name")
            self.turn = welcome.get("turn")
            self._set("online")
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    self._on_frame(msg.data)
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
            self._ws = None

    def _on_frame(self, msg):
        if len(msg) < 5:
            return
        kind, sid, payload = parse_frame(msg)
        if kind == OPEN:
            self.streams[sid] = _Stream(self, sid)
            self.stats["total"] += 1
            self.stats["active"] = len(self.streams)
            self._changed()
            return
        st = self.streams.get(sid)
        if st is None:
            return
        if kind == DATA:
            self.stats["rx"] += len(payload)
            st.queue.put_nowait(payload)
        elif kind == WINDOW and len(payload) >= 4:
            st.add_credit(struct.unpack("!I", payload[:4])[0])
        elif kind == EOF:
            st.queue.put_nowait(None)
        elif kind == CLOSE:
            st.abort(notify=False)

    async def _send(self, data):
        ws = self._ws
        if ws is None or ws.closed:
            raise ConnectionError("нет соединения с relay")
        async with self._lock:
            await ws.send_bytes(data)

    async def _send_quiet(self, data):
        try:
            await self._send(data)
        except Exception:
            pass

    def _drop_streams(self):
        for st in list(self.streams.values()):
            st.abort(notify=False)
        self.streams.clear()
        self.stats["active"] = 0

    def _log_request(self, data):
        if not self.on_request:
            return
        line = data.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        parts = line.split(" ")
        if len(parts) >= 2 and parts[0].isupper():
            try:
                self.on_request(parts[0], parts[1][:200])
            except Exception:
                pass

    def _set(self, status, error=None):
        self.status = status
        self.error = error
        if self.on_status:
            try:
                self.on_status(self)
            except Exception:
                pass

    def _changed(self):
        # статистику отдаём не чаще пары раз в секунду
        now = time.monotonic()
        if now - self._last_change > 0.5 and self.on_status:
            self._last_change = now
            try:
                self.on_status(self)
            except Exception:
                pass
