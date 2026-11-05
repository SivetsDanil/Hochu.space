"""Туннель в интернет для TabChat: при запуске чат сам получает ссылку, доступную из любой сети.

Два способа:
  • по умолчанию — бесплатный туннель через встроенный в Windows ssh, без своего сервера и регистрации.
    Основной сервис srv.us выдаёт постоянный адрес, выведенный из ключа ssh в папке данных:
    после первого запуска ссылка печатается сразу и не меняется. Запасной — localhost.run
    (адрес новый при каждом подключении), если srv.us недоступен;
  • свой relay TabTunnel (tunnel/README.md) — постоянный адрес на своём сервере:
        TabChat.exe --tunnel tabtunnel://секрет@1-2-3-4.sslip.io/имя

Выбор запоминается в data/tunnel.json:
    --tunnel КЛЮЧ   свой relay          --tunnel free   снова бесплатный туннель
    --tunnel-off    без туннеля         --no-tunnel     без туннеля только в этот раз
"""
import asyncio
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time

from tunnel.tabtunnel import KeyError_, TunnelClient, parse_key

CONFIG_NAME = "tunnel.json"
KEY_NAME = "tunnel_key"
FREE_NAMES = ("free", "auto", "srv.us", "localhost.run")
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

# Бесплатные сервисы по порядку предпочтения. timeout — сколько ждём адрес, прежде чем пробовать следующий.
PROVIDERS = (
    {"name": "srv.us", "host": "tabchat@srv.us", "remote": "1:localhost:%d", "stable": True, "timeout": 12,
     "re": re.compile(r"(https://[a-z0-9]+\.srv\.us)/?"),
     "opts": ("-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no")},
    {"name": "localhost.run", "host": "nokey@localhost.run", "remote": "80:localhost:%d", "stable": False,
     "timeout": 25, "re": re.compile(r"tunneled with tls termination,\s*(https://[^\s,]+)"),
     "opts": ("-o", "PubkeyAuthentication=no")},       # свои ключи стороннему сервису не показываем
)


def load_config(data_dir):
    try:
        with open(os.path.join(data_dir, CONFIG_NAME), encoding="utf-8") as f:
            cfg = json.load(f)
            return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(data_dir, cfg):
    os.makedirs(data_dir, exist_ok=True)
    path = os.path.join(data_dir, CONFIG_NAME)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def configure(data_dir, key=None, name=None, disable=False):
    """Обновляет сохранённые настройки по флагам командной строки. Возвращает итоговый конфиг."""
    cfg = load_config(data_dir)
    changed = False
    if disable:
        cfg["mode"] = "off"
        changed = True
    if key:
        if key.strip().lower() in FREE_NAMES:
            cfg["mode"] = "free"
            if key.strip().lower() in ("srv.us", "localhost.run"):
                cfg["free_first"] = key.strip().lower()     # какой бесплатный сервис пробовать первым
        else:
            parse_key(key)                  # проверяем формат сразу, до запуска
            cfg.update(key=key.strip(), mode="relay")
        changed = True
    if name is not None:
        cfg["name"] = name.strip().lower() or None
        changed = True
    if "mode" not in cfg:
        # настройки из прошлой версии: ключ relay без поля mode
        cfg["mode"] = "relay" if cfg.get("key") and cfg.get("enabled", True) else "free"
    cfg.setdefault("client_id", secrets.token_hex(8))
    if changed:
        save_config(data_dir, cfg)
    return cfg


def quiet_run(args, timeout):
    subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   check=True, timeout=timeout, creationflags=CREATE_NO_WINDOW)


def restrict_to_owner(path):
    """ssh не берёт закрытый ключ, который могут читать другие пользователи, а папка с exe бывает где угодно."""
    try:
        if sys.platform != "win32":
            os.chmod(path, 0o600)
        elif os.environ.get("USERNAME"):
            quiet_run(["icacls", path, "/inheritance:r", "/grant:r", os.environ["USERNAME"] + ":F"], 15)
    except (OSError, subprocess.SubprocessError):
        pass


def ensure_key(data_dir):
    """Ключ ssh для srv.us: от него сервис выводит постоянный адрес. Создаётся один раз в папке данных.
    Возвращает (путь к ключу, открытый ключ) или (None, None), если ssh-keygen нет."""
    path = os.path.join(data_dir, KEY_NAME)
    if not (os.path.exists(path) and os.path.exists(path + ".pub")):
        keygen = shutil.which("ssh-keygen")
        if not keygen:
            return None, None
        for p in (path, path + ".pub"):
            if os.path.exists(p):
                os.remove(p)
        try:
            os.makedirs(data_dir, exist_ok=True)
            quiet_run([keygen, "-q", "-t", "ed25519", "-N", "", "-C", "tabchat-tunnel", "-f", path], 30)
        except (OSError, subprocess.SubprocessError):
            return None, None
    restrict_to_owner(path)
    try:
        with open(path + ".pub", encoding="ascii") as f:
            return path, f.read().split()[1]
    except (OSError, IndexError, UnicodeDecodeError):
        return None, None


def copy_to_clipboard(text):
    """Ссылку сразу в буфер обмена — осталось вставить другу в сообщение."""
    if sys.platform != "win32":
        return False
    try:
        subprocess.run(["clip"], input=text.encode("ascii", "ignore"), check=True, timeout=5,
                       creationflags=CREATE_NO_WINDOW)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def announce(url, note=""):
    copied = copy_to_clipboard(url)
    print("  Из интернета:           {}{}".format(url, "   (скопирована в буфер обмена)" if copied else ""), flush=True)
    if note:
        print("  " + note, flush=True)


def bind_to_this_process(pid):
    """Дочерний процесс (ssh) умрёт вместе с чатом, даже если окно просто закрыли.
    Windows: Job Object с KILL_ON_JOB_CLOSE; дескриптор задания живёт, пока жив наш процесс."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)

        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class Io(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOperationCount", "WriteOperationCount",
                                                       "OtherOperationCount", "ReadTransferCount",
                                                       "WriteTransferCount", "OtherTransferCount")]

        class Extended(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", Io), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = Extended()
        info.BasicLimitInformation.LimitFlags = 0x2000          # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))  # JobObjectExtendedLimitInformation
        proc = k32.OpenProcess(0x0001 | 0x0100, False, pid)     # PROCESS_TERMINATE | PROCESS_SET_QUOTA
        if proc:
            k32.AssignProcessToJobObject(job, proc)
            k32.CloseHandle(proc)
        return job                                               # не закрываем: закроется вместе с нами
    except Exception:
        return None


class FreeTunnel:
    """Бесплатный туннель через ssh -R, без регистрации. Основной сервис — srv.us: адрес выводится
    из ключа ssh в папке данных, поэтому он постоянный и после первого запуска печатается сразу.
    Если srv.us не ответил, пробуем localhost.run (его адрес новый при каждом подключении)."""

    def __init__(self, hub, port, data_dir):
        self.hub, self.port, self.data_dir = hub, port, data_dir
        # по умолчанию первым — localhost.run: на практике он работал быстрее; srv.us — запасной
        # (выбрать: --tunnel srv.us или --tunnel localhost.run)
        self.first = load_config(data_dir).get("free_first") or "localhost.run"
        self.known_hosts = os.path.join(data_dir, "known_hosts")
        self.proc = None
        self.url = None                 # адрес, который сейчас выдан друзьям
        self.stopped = False
        self.task = None
        self._jobs = []

    def start(self):
        # постоянный адрес известен с прошлого запуска — выдаём его сразу, туннель догонит за пару секунд
        cfg = load_config(self.data_dir)
        url = cfg.get("free_url")
        pub = os.path.join(self.data_dir, KEY_NAME + ".pub")
        try:
            with open(pub, encoding="ascii") as f:
                same_key = f.read().split()[1] == cfg.get("free_key")
        except (OSError, IndexError, UnicodeDecodeError):
            same_key = False
        if url and same_key and self.first == "srv.us":
            self.url = url
            announce(url, "Ссылка постоянная. Туннель подключается — она заработает через пару секунд.")
            asyncio.ensure_future(self.hub.set_public(url, None, "free"))
        self.task = asyncio.ensure_future(self.run())
        return self

    def stop(self):
        self.stopped = True
        self._kill()

    def _kill(self):
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass

    async def run(self):
        ssh = shutil.which("ssh")
        if not ssh:
            print("  Туннель: в Windows не найден ssh. Включите «Клиент OpenSSH»: Параметры → Приложения →",
                  "Дополнительные компоненты. Или используйте свой relay (tunnel/README.md).", flush=True)
            return
        if not self.url:
            print("  Туннель: получаю адрес в интернете…", flush=True)
        key, pub = await asyncio.get_running_loop().run_in_executor(None, ensure_key, self.data_dir)
        providers = sorted((p for p in PROVIDERS if key or not p["stable"]), key=lambda p: p["name"] != self.first)
        delay, i = 1, 0
        while not self.stopped:
            p = providers[i % len(providers)]
            try:
                online_for = await self._session(ssh, p, key, pub)
            except asyncio.CancelledError:
                self.stop()
                raise
            except Exception as e:  # ssh внезапно пропал и т. п.
                print("  Туннель: {}".format(e), flush=True)
                online_for = None
            if self.stopped:
                break
            if online_for is None:
                # сервис не выдал адрес — сразу пробуем следующий, а после полного круга ждём
                i += 1
                if i % len(providers) == 0:
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 30)
                else:
                    print("  Туннель: {} не отвечает — пробую {}…".format(p["name"], providers[i % len(providers)]["name"]),
                          flush=True)
                continue
            print("  Туннель: связь с {} прервалась — переподключаюсь…".format(p["name"]), flush=True)
            if not p["stable"]:
                self.url = None
                await self.hub.set_public(None, None)
            i = 0                                        # снова начинаем с постоянного адреса
            if online_for > 30:
                delay = 1                                # долго проработал — переподключаемся сразу
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    async def _session(self, ssh, p, key, pub):
        """Один сеанс ssh. Возвращает, сколько секунд туннель проработал, или None, если адрес не получен."""
        started = time.monotonic()
        args = [ssh, "-T", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=" + self.known_hosts,
                "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "ExitOnForwardFailure=yes",
                "-o", "ConnectTimeout=10", *p["opts"]]
        if p["stable"]:
            args += ["-i", key]
        args += ["-R", p["remote"] % self.port, p["host"]]
        self.proc = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, creationflags=CREATE_NO_WINDOW)
        job = bind_to_this_process(self.proc.pid)
        if job:
            self._jobs = [job]
        online_at = None

        async def read():
            nonlocal online_at
            async for raw in self.proc.stdout:
                m = p["re"].search(raw.decode("utf-8", "replace"))
                if m and online_at is None:
                    online_at = time.monotonic()
                    await self._online(p, m.group(1), online_at - started, pub)

        reader = asyncio.ensure_future(read())
        try:
            while online_at is None and not reader.done():
                if time.monotonic() - started > p["timeout"]:
                    self._kill()
                    break
                await asyncio.sleep(0.1)
            await reader
            await self.proc.wait()
        finally:
            reader.cancel()
            self._kill()
        return None if online_at is None else time.monotonic() - online_at

    async def _online(self, p, url, took, pub):
        if p["stable"]:
            cfg = load_config(self.data_dir)
            if (cfg.get("free_url"), cfg.get("free_key")) != (url, pub):
                cfg.update(free_url=url, free_key=pub)
                save_config(self.data_dir, cfg)
        if url != self.url:
            self.url = url
            announce(url, "Ссылка постоянная — её можно сохранить, после перезапуска она не изменится."
                     if p["stable"] else
                     "Ссылка localhost.run меняется при каждом запуске сервера — отправьте друзьям новую.")
        else:
            print("  Туннель подключён за {:.1f} с — ссылка работает.".format(took), flush=True)
        await self.hub.set_public(url, None, "free" if p["stable"] else "temp")


class RelayTunnel:
    """Свой relay TabTunnel: постоянный адрес и TURN для звонков."""

    def __init__(self, hub, port, cfg):
        self.hub = hub
        self.client = TunnelClient(cfg["key"], port, name=cfg.get("name"), client_id=cfg.get("client_id"),
                                   on_status=self._on_status)
        self._last = None
        self.task = None

    def start(self):
        self.task = asyncio.ensure_future(self.client.run())
        return self

    def stop(self):
        self.client.stop()

    def _on_status(self, c):
        state = (c.status, c.url, c.error)
        if state == self._last:
            return
        self._last = state
        if c.status == "connecting" and self.hub.public_url is None:
            print("  Туннель: подключаюсь к своему relay {}…".format(c.key.display), flush=True)
        elif c.status == "online":
            announce(c.url)
            asyncio.ensure_future(self.hub.set_public(c.url, c.turn, "relay"))
        elif c.status == "offline":
            print("  Туннель: {} — переподключаюсь…".format(c.error or "нет связи"), flush=True)
            asyncio.ensure_future(self.hub.set_public(None, None))
        elif c.status == "error":
            print("  Туннель выключен: {}".format(c.error), flush=True)
            asyncio.ensure_future(self.hub.set_public(None, None))


def start_tunnel(hub, data_dir, port, args):
    """Поднимает туннель по сохранённым настройкам. Возвращает объект с .stop() или None."""
    try:
        cfg = configure(data_dir, key=args.tunnel, name=args.tunnel_name, disable=args.tunnel_off)
    except KeyError_ as e:
        print("  Ключ туннеля не подошёл: {}".format(e))
        cfg = load_config(data_dir)
    if args.no_tunnel or cfg.get("mode") == "off":
        print("  Туннель в интернет выключен (включить: --tunnel free).", flush=True)
        return None
    if cfg.get("mode") == "relay" and cfg.get("key"):
        return RelayTunnel(hub, port, cfg).start()
    return FreeTunnel(hub, port, data_dir).start()
