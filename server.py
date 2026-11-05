"""TabChat Server — сервер мессенджера: аккаунты, чаты, вкладки, голосовые каналы, файлы, карта групп.

Запуск:  TabChat-Server.exe                       окно со ссылкой для друзей
         python server.py [--port 8080] [--https-port 8443] [--no-browser] [--tunnel КЛЮЧ|free] [--no-tunnel]
         python server.py --gui                   то же окно из исходников
При запуске сам получает ссылку, доступную из интернета (бесплатный туннель или свой relay).
Данные (база, файлы, сертификат, настройки туннеля) лежат в папке data/ рядом с exe или скриптом.
Друзья заходят по ссылке в браузере или через приложение TabChat.exe (его можно скачать с сервера).
"""
import argparse
import asyncio
import os
import ssl
import sys
import webbrowser

from aiohttp import web

from tabchat.db import DB
from tabchat.netutil import ensure_cert, lan_ips
from tabchat.tunnel_link import start_tunnel
from tabchat.web import make_app

CLIENT_EXE = "TabChat.exe"        # приложение рядом с сервером: его раздаём друзьям и открываем кнопкой


def resource_path(rel):
    """Путь к файлам, упакованным внутрь exe (PyInstaller распаковывает их в _MEIPASS)."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def app_dir():
    """Папка рядом с exe (или со скриптом) — туда пишем данные."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def data_path(args):
    return os.path.abspath(args.data or os.path.join(app_dir(), "data"))


def client_exe():
    path = os.path.join(app_dir(), CLIENT_EXE)
    return path if os.path.isfile(path) else None


def lock_data_dir(data_dir):
    """Второй сервер с той же папкой данных испортил бы базу (а через srv.us запросы делились бы между
    ними) — поэтому папку занимает один сервер. Блокировка снимается сама, когда процесс завершается."""
    os.makedirs(data_dir, exist_ok=True)
    f = open(os.path.join(data_dir, "server.lock"), "a+")
    try:
        if sys.platform == "win32":
            import msvcrt
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        raise RuntimeError("TabChat Server уже запущен с этими данными ({}). Закройте его окно.".format(data_dir))
    return f


async def start_site(runner, host, port, ssl_context=None, tries=20):
    for p in range(port, port + tries):
        site = web.TCPSite(runner, host, p, ssl_context=ssl_context)
        try:
            await site.start()
            return p
        except OSError:
            continue
    raise OSError("Не нашлось свободного порта начиная с {}".format(port))


async def run(args, stop=None, on_ready=None):
    """stop — asyncio.Event для остановки (окно сервера); on_ready(state) — сервер поднялся."""
    data_dir = data_path(args)
    lock = lock_data_dir(data_dir)
    db = DB(os.path.join(data_dir, "tabchat.db"))
    app = make_app(db, resource_path("static"), os.path.join(data_dir, "media"), client_exe=client_exe())
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()

    http_port = await start_site(runner, args.host, args.port)
    ips = lan_ips()
    https_port = None
    try:
        cert, key = ensure_cert(data_dir, ips)
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(cert, key)
        https_port = await start_site(runner, args.host, args.https_port, ssl_context=ctx)
    except Exception as e:
        print("HTTPS не запущен:", e)

    if on_ready:                                    # в окне адреса и так видны — в журнал только суть
        print("Сервер запущен на порту {}. Данные: {}".format(http_port, data_dir))
    else:
        line = "=" * 66
        print(line)
        print("  TabChat Server запущен")
        print(line)
        print("  На этом компьютере:     http://localhost:{}".format(http_port))
        if https_port:
            for ip in ips:
                print("  Для других в сети:      https://{}:{}".format(ip, https_port))
            print()
            print("  По https браузер предупредит о сертификате — нажмите")
            print("  «Дополнительно» → «Перейти на сайт». Это нужно для микрофона и камеры.")
        print()
        print("  Данные:  {}".format(data_dir))
        print("  Остановить сервер: Ctrl+C или закрыть это окно.")
        print(line, flush=True)

    hub = app["hub"]
    hub.lan_urls = ["https://{}:{}".format(ip, https_port) for ip in ips] if https_port else []
    # ссылка для друзей из любой сети: бесплатный туннель или свой relay (см. tabchat/tunnel_link.py)
    tunnel = start_tunnel(hub, data_dir, http_port, args)
    if on_ready:
        on_ready({"hub": hub, "http_port": http_port, "https_port": https_port, "ips": ips,
                  "data_dir": data_dir, "tunnel": tunnel is not None, "client_exe": client_exe()})
    elif not args.no_browser:
        webbrowser.open("http://localhost:{}".format(http_port))

    try:
        if stop:
            await stop.wait()
        else:
            while True:
                await asyncio.sleep(3600)
    finally:
        if tunnel:
            tunnel.stop()
            if tunnel.task:                    # дождаться, пока туннель закроет ssh, — без мусора в журнале
                done, _ = await asyncio.wait([tunnel.task], timeout=3)
                if not done:
                    tunnel.task.cancel()
        await runner.cleanup()
        lock.close()


def main():
    # консоль Windows / перенаправленный вывод могут быть в cp1251 — не падаем на «лишних» символах
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="TabChat Server — сервер мессенджера")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--https-port", type=int, default=8443)
    parser.add_argument("--data", help="папка для базы и файлов (по умолчанию data/ рядом с программой)")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--gui", action="store_true", help="окно сервера (по умолчанию у exe)")
    parser.add_argument("--console", action="store_true", help="без окна, всё в консоли (для VPS и Linux)")
    parser.add_argument("--tunnel", metavar="КЛЮЧ",
                        help="ключ своего relay TabTunnel (запоминается) или free — бесплатный туннель (по умолчанию)")
    parser.add_argument("--tunnel-name", metavar="ИМЯ", help="желаемое имя на своём relay: https://ИМЯ.домен-relay")
    parser.add_argument("--tunnel-off", action="store_true", help="выключить туннель в интернет насовсем")
    parser.add_argument("--no-tunnel", action="store_true", help="не поднимать туннель в этот раз")
    args = parser.parse_args()
    if args.gui or (getattr(sys, "frozen", False) and not args.console):
        from tabchat.server_gui import run_gui
        run_gui(args, run, data_path(args))
        return
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        print("Сервер остановлен.")
    except RuntimeError as e:
        print(e)
        sys.exit(1)


if __name__ == "__main__":
    main()
