"""Протокол TabTunnel: кадры внутри WebSocket и разбор «ключа подключения».

Кадр: [1 байт тип][4 байта id потока][данные]. Поток = одно соединение посетителя.
Поток открывает только relay (OPEN), дальше обе стороны шлют DATA, подтверждают
прочитанное через WINDOW (управление потоком), сообщают о конце данных EOF
и обрывают поток CLOSE.
"""
import struct
from urllib.parse import unquote, urlsplit

PROTOCOL = 1
OPEN, DATA, CLOSE, WINDOW, EOF = 1, 2, 3, 4, 5
WINDOW_SIZE = 256 * 1024
CHUNK = 32 * 1024


def frame(kind, sid, payload=b""):
    return struct.pack("!BI", kind, sid) + payload


def parse_frame(msg):
    kind, sid = struct.unpack("!BI", msg[:5])
    return kind, sid, msg[5:]


class KeyError_(ValueError):
    """Ключ подключения записан неправильно."""


class TunnelKey:
    def __init__(self, ws_url, token, name, display):
        self.ws_url, self.token, self.name, self.display = ws_url, token, name, display


def parse_key(key, name=None):
    """
    tabtunnel://КЛЮЧ@relay.example.com[/имя]   — защищённое подключение (wss)
    tabtunnel+ws://КЛЮЧ@127.0.0.1:7000[/имя]   — без шифрования, для проверки у себя
    """
    key = (key or "").strip()
    u = urlsplit(key)
    schemes = {"tabtunnel": "wss", "tabtunnels": "wss", "tabtunnel+ws": "ws", "tabtunnel+wss": "wss"}
    if u.scheme not in schemes:
        raise KeyError_("Ключ должен начинаться с tabtunnel://")
    if not u.hostname or not u.username:
        raise KeyError_("В ключе нет адреса сервера или секрета: tabtunnel://секрет@адрес")
    token = unquote(u.username)
    host = u.hostname if ":" not in u.hostname else "[%s]" % u.hostname
    port = ":%d" % u.port if u.port else ""
    path_name = u.path.strip("/") or None
    ws_url = "%s://%s%s/_tunnel" % (schemes[u.scheme], host, port)
    return TunnelKey(ws_url, token, (name or path_name or None), "%s%s" % (host, port))
