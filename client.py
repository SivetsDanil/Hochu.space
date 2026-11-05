"""TabChat — приложение для Windows: окно мессенджера, подключённое к серверу TabChat Server.

Запуск:  TabChat.exe [ссылка на сервер или приглашение]
         python client.py [ссылка] [--browser путь\\к\\msedge.exe]

Окно — Edge (или Chrome) в режиме приложения, без адресной строки. Код клиента встроен в exe,
а к серверу ходит локальный прокси (см. tabchat/appclient.py). Приложение завершается, когда
закрыто последнее его окно.
"""
import argparse
import asyncio
import logging
import os
import subprocess
import sys
import time
import webbrowser

import aiohttp

from tabchat.appclient import LAUNCHER_PORT, AppProxy, ServerError, data_dir

log = logging.getLogger("tabchat.app")
FIRST_WINDOW_WAIT = 120     # столько ждём, пока откроется первое окно
LAST_WINDOW_GRACE = 8       # окно перезагружается или переходит на другой сервер — не выходим сразу


def resource_path(rel):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def message_box(text, title="TabChat"):
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x40)
    else:
        print(text)


def find_browser():
    """Edge есть в любой Windows 10/11; если его убрали — Chrome. Путь берём из реестра App Paths."""
    if sys.platform != "win32":
        return None
    import winreg
    for exe in ("msedge.exe", "chrome.exe"):
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(hive, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe) as key:
                    path = (winreg.QueryValue(key, None) or "").strip('"')
            except OSError:
                continue
            if path and os.path.isfile(path):
                return path
    for env, rel in (("ProgramFiles(x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
                     ("ProgramFiles", "Microsoft\\Edge\\Application\\msedge.exe"),
                     ("ProgramFiles", "Google\\Chrome\\Application\\chrome.exe"),
                     ("LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe")):
        path = os.path.join(os.environ.get(env, ""), rel)
        if os.path.isfile(path):
            return path
    return None


def open_window(url, browser=None):
    """Окно без адресной строки со своим профилем: его хранилище (ключи шифрования, аккаунты) отдельно
    от обычного браузера и не пропадает при чистке истории."""
    browser = browser or find_browser()
    if not browser:
        log.info("браузер для окна не найден — открываю %s в браузере по умолчанию", url)
        webbrowser.open(url)
        return
    if os.environ.get("TABCHAT_CLIENT_DATA"):
        profile = os.path.join(data_dir(), "Browser")
    else:
        profile = os.path.join(os.environ.get("LOCALAPPDATA") or data_dir(), "TabChat", "Browser")
    os.makedirs(profile, exist_ok=True)
    args = [browser, "--app=" + url, "--user-data-dir=" + profile, "--no-first-run",
            "--no-default-browser-check", "--hide-crash-restore-bubble", "--window-size=1200,820"]
    log.info("окно: %s", url)
    subprocess.Popen(args, close_fds=True, creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))


async def already_running(link):
    """Приложение уже открыто: просим его подключить ссылку (если есть) и даём адрес для нового окна."""
    base = "http://127.0.0.1:%d" % LAUNCHER_PORT
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25)) as s:
            async with s.get(base + "/app/info") as r:
                info = await r.json(content_type=None)
            if not info.get("app"):
                return None
            if link:
                async with s.post(base + "/app/connect", json={"url": link}, headers={"X-TabChat-App": "1"}) as r:
                    res = await r.json(content_type=None)
                if r.status != 200:
                    message_box(res.get("error") or "Не получилось подключиться к серверу")
                    return base
                return res["server"]["origin"] + res["path"]
            last = next((s for s in info.get("servers") or [] if s["id"] == info.get("last")), None)
            return last["origin"] if last else base
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
        return None


async def run(args):
    proxy = AppProxy(resource_path("static"))
    try:
        await proxy.start()
    except OSError:
        target = await already_running(args.link)
        if target:
            open_window(target, args.browser)
            return 0
        message_box("Порт %d занят другой программой — TabChat не может запуститься." % LAUNCHER_PORT)
        return 1

    target = "http://127.0.0.1:%d/" % LAUNCHER_PORT
    if args.link:
        try:
            srv, path = await proxy.connect(args.link)
            target = "http://127.0.0.1:%d%s" % (srv["port"], path)
        except ServerError as e:
            message_box(str(e))
    else:
        last = proxy.last_server()
        if last and last["port"] in proxy.sites:
            target = "http://127.0.0.1:%d/" % last["port"]
    if args.no_window:
        log.info("без окна: откройте %s сами", target)
    else:
        open_window(target, args.browser)

    # живём, пока открыто хотя бы одно окно (каждое держит соединение /app/alive)
    started = time.monotonic()
    while True:
        await asyncio.sleep(1)
        if proxy.alive:
            continue
        if not proxy.seen_window and time.monotonic() - started > FIRST_WINDOW_WAIT:
            log.info("окно так и не открылось — выхожу")
            break
        if proxy.seen_window and time.monotonic() - proxy.last_alive > LAST_WINDOW_GRACE:
            log.info("окна закрыты — выхожу")
            break
    await proxy.stop()
    return 0


def setup_logging():
    path = os.path.join(data_dir(), "client.log")
    os.makedirs(data_dir(), exist_ok=True)
    try:
        if os.path.getsize(path) > 1024 * 1024:
            os.replace(path, path + ".old")
    except OSError:
        pass
    handlers = [logging.FileHandler(path, encoding="utf-8")]
    if sys.stdout is not None:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", handlers=handlers)


def main():
    parser = argparse.ArgumentParser(description="TabChat — приложение для Windows")
    parser.add_argument("link", nargs="?", help="ссылка на сервер или приглашение в группу")
    parser.add_argument("--browser", help="путь к браузеру для окна (по умолчанию Edge или Chrome)")
    parser.add_argument("--data", help="папка настроек приложения (по умолчанию %%APPDATA%%\\TabChat)")
    parser.add_argument("--no-window", action="store_true", help="не открывать окно (для проверок)")
    args = parser.parse_args()
    if args.data:
        os.environ["TABCHAT_CLIENT_DATA"] = os.path.abspath(args.data)
    setup_logging()
    log.info("TabChat запущен")
    try:
        code = asyncio.run(run(args))
    except Exception as e:  # окно приложения без консоли — показываем ошибку, а не молча падаем
        log.exception("сбой")
        message_box("TabChat не смог запуститься: %s" % e)
        code = 1
    sys.exit(code)


if __name__ == "__main__":
    main()
