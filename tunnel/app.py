"""TabTunnel — открыть любой локальный порт в интернет через свой relay (как ngrok/tuna).

Окно:      TabTunnel.exe                      (или python tunnel/app.py)
Консоль:   TabTunnel.exe 8080 --key tabtunnel://секрет@relay.example.com [--name имя]
           TabTunnel.exe http 8080            (ключ берётся из сохранённых настроек)
"""
import argparse
import asyncio
import json
import os
import queue
import sys
import threading
import time
import webbrowser

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tabtunnel import KeyError_, TunnelClient, parse_key  # noqa: E402

APP = "TabTunnel"
STATUS_TEXT = {"idle": "Не запущен", "connecting": "Подключение…", "online": "В сети",
               "offline": "Нет связи", "error": "Ошибка"}


def config_path():
    base = os.environ.get("APPDATA") or os.path.expanduser("~/.config")
    return os.path.join(base, APP, "config.json")


def load_config():
    try:
        with open(config_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def human(n):
    for unit in ("Б", "КБ", "МБ", "ГБ"):
        if n < 1024 or unit == "ГБ":
            return ("%d %s" % (n, unit)) if unit == "Б" else ("%.1f %s" % (n, unit))
        n /= 1024


# ============================================================ консоль

def run_cli(args, cfg):
    key = args.key or cfg.get("key")
    if not key:
        print("Нужен ключ подключения: --key tabtunnel://секрет@адрес-relay")
        return 2
    try:
        parse_key(key)
    except KeyError_ as e:
        print("Ключ не подошёл:", e)
        return 2
    cfg.update(key=key, port=args.port, name=args.name or cfg.get("name"))
    cfg.setdefault("client_id", os.urandom(8).hex())
    save_config(cfg)

    last = {}

    def on_status(c):
        state = (c.status, c.url, c.error)
        if last.get("state") == state:
            return
        last["state"] = state
        line = "  Статус:  %s" % STATUS_TEXT.get(c.status, c.status)
        if c.error:
            line += " — " + c.error
        print(line, flush=True)
        if c.status == "online":
            print("  Ссылка:  %s\n           → http://127.0.0.1:%d\n" % (c.url, args.port), flush=True)

    def on_request(method, path):
        print("  %s  %-6s %s" % (time.strftime("%H:%M:%S"), method, path), flush=True)

    print("TabTunnel → relay %s" % parse_key(key).display, flush=True)
    client = TunnelClient(key, args.port, name=cfg.get("name"), client_id=cfg["client_id"],
                          on_status=on_status, on_request=on_request)
    try:
        asyncio.run(client.run())
    except KeyboardInterrupt:
        pass
    return 0 if client.status != "error" else 1


# ============================================================ окно

def run_gui(cfg):
    import tkinter as tk

    BG, CARD, FIELD, TEXT, MUTED, ACCENT, GREEN, RED, ORANGE = (
        "#0e1621", "#17212b", "#202b36", "#e8eef4", "#7d8e9e", "#5eb5f7", "#4fce6e", "#ec5b56", "#f0a43a")
    FONT = ("Segoe UI", 10)

    root = tk.Tk()
    root.title(APP)
    root.geometry("480x700")
    root.minsize(420, 560)
    root.configure(bg=BG)
    icon = os.path.join(getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))), "icon.png")
    if os.path.exists(icon):
        try:
            root.iconphoto(True, tk.PhotoImage(file=icon))
        except tk.TclError:
            pass

    events = queue.Queue()
    state = {"client": None, "loop": None, "thread": None, "log": 0}

    def label(parent, text, size=10, color=TEXT, bold=False, **kw):
        return tk.Label(parent, text=text, bg=parent["bg"], fg=color,
                        font=("Segoe UI Semibold" if bold else "Segoe UI", size), **kw)

    # шапка
    head = tk.Frame(root, bg=BG)
    head.pack(fill="x", padx=20, pady=(18, 8))
    label(head, "TabTunnel", 16, bold=True).pack(side="left")
    status_lbl = label(head, "● " + STATUS_TEXT["idle"], 10, MUTED)
    status_lbl.pack(side="right")

    # карточка со ссылкой
    card = tk.Frame(root, bg=CARD, padx=16, pady=14)
    card.pack(fill="x", padx=20)
    url_var = tk.StringVar(value="Ссылка появится после запуска")
    url_lbl = tk.Label(card, textvariable=url_var, bg=CARD, fg=MUTED, font=("Segoe UI Semibold", 12),
                       anchor="w", cursor="arrow", wraplength=420, justify="left")
    url_lbl.pack(fill="x")
    target_lbl = label(card, "", 9, MUTED, anchor="w")
    target_lbl.pack(fill="x", pady=(2, 8))
    copy_btn = tk.Button(card, text="Копировать ссылку", bg=FIELD, fg=TEXT, activebackground=ACCENT,
                         activeforeground="#fff", relief="flat", bd=0, padx=12, pady=5, font=FONT,
                         state="disabled", cursor="hand2")
    copy_btn.pack(anchor="w")

    # поля
    form = tk.Frame(root, bg=BG)
    form.pack(fill="x", padx=20, pady=(14, 0))

    def field(row, title, value, width=None, show=None):
        label(form, title, 9, MUTED).grid(row=row, column=0, sticky="w", pady=(6, 2))
        var = tk.StringVar(value=value)
        e = tk.Entry(form, textvariable=var, bg=FIELD, fg=TEXT, insertbackground=TEXT, relief="flat",
                     font=FONT, show=show or "", highlightthickness=1, highlightbackground=FIELD,
                     highlightcolor=ACCENT)
        e.grid(row=row + 1, column=0, sticky="we", ipady=6)
        return var, e

    form.columnconfigure(0, weight=1)
    key_var, key_entry = field(0, "Ключ подключения", cfg.get("key", ""), show="•")
    port_var, _ = field(2, "Локальный порт", str(cfg.get("port", 8080)))
    name_var, _ = field(4, "Имя (необязательно) — будет https://имя.домен-relay", cfg.get("name") or "")

    show_key = tk.BooleanVar(value=False)
    tk.Checkbutton(form, text="показать ключ", variable=show_key, bg=BG, fg=MUTED, selectcolor=FIELD,
                   activebackground=BG, activeforeground=TEXT, font=("Segoe UI", 9), bd=0,
                   command=lambda: key_entry.config(show="" if show_key.get() else "•")).grid(row=6, column=0, sticky="w")

    btn = tk.Button(root, text="Запустить", bg=ACCENT, fg="#fff", activebackground="#3e8fd6",
                    activeforeground="#fff", relief="flat", bd=0, font=("Segoe UI Semibold", 11),
                    pady=8, cursor="hand2")
    btn.pack(fill="x", padx=20, pady=(14, 8))
    error_lbl = label(root, "", 9, RED, anchor="w", wraplength=440, justify="left")
    error_lbl.pack(fill="x", padx=20)

    stats_lbl = label(root, "", 9, MUTED, anchor="w")
    stats_lbl.pack(fill="x", padx=20, pady=(6, 4))

    log_frame = tk.Frame(root, bg=CARD)
    log_frame.pack(fill="both", expand=True, padx=20, pady=(0, 18))
    log = tk.Listbox(log_frame, bg=CARD, fg=TEXT, font=("Consolas", 9), relief="flat", bd=0,
                     highlightthickness=0, selectbackground=FIELD, activestyle="none")
    log.pack(fill="both", expand=True, padx=10, pady=8)
    log.insert("end", "Здесь будут запросы из интернета")
    log.itemconfig(0, fg=MUTED)

    # ---------- асинхронная часть в отдельном потоке ----------
    def ensure_loop():
        if state["loop"] is None:
            loop = asyncio.new_event_loop()
            t = threading.Thread(target=loop.run_forever, daemon=True)
            t.start()
            state["loop"], state["thread"] = loop, t
        return state["loop"]

    def start():
        error_lbl.config(text="")
        key = key_var.get().strip()
        try:
            parse_key(key)
            port = int(port_var.get())
            assert 0 < port < 65536
        except KeyError_ as e:
            error_lbl.config(text=str(e))
            return
        except (ValueError, AssertionError):
            error_lbl.config(text="Порт — число от 1 до 65535")
            return
        cfg.update(key=key, port=port, name=name_var.get().strip().lower() or None)
        cfg.setdefault("client_id", os.urandom(8).hex())
        save_config(cfg)
        client = TunnelClient(key, port, name=cfg["name"], client_id=cfg["client_id"],
                              on_status=lambda c: events.put(("status", None)),
                              on_request=lambda m, p: events.put(("request", (m, p))))
        state["client"] = client
        target_lbl.config(text="→ http://127.0.0.1:%d" % port)
        asyncio.run_coroutine_threadsafe(client.run(), ensure_loop())
        refresh()

    def stop():
        client = state["client"]
        if client:
            state["loop"].call_soon_threadsafe(client.stop)

    def toggle():
        c = state["client"]
        if c and c.status not in ("idle", "error"):
            stop()
        else:
            start()

    def copy():
        c = state["client"]
        if c and c.url:
            root.clipboard_clear()
            root.clipboard_append(c.url)
            copy_btn.config(text="Скопировано ✓")
            root.after(1500, lambda: copy_btn.config(text="Копировать ссылку"))

    def open_url(_e=None):
        c = state["client"]
        if c and c.url and c.status == "online":
            webbrowser.open(c.url)

    btn.config(command=toggle)
    copy_btn.config(command=copy)
    url_lbl.bind("<Button-1>", open_url)

    def refresh():
        c = state["client"]
        status = c.status if c else "idle"
        color = {"online": GREEN, "connecting": ORANGE, "offline": ORANGE, "error": RED}.get(status, MUTED)
        status_lbl.config(text="● " + STATUS_TEXT.get(status, status), fg=color)
        running = c is not None and status not in ("idle", "error")
        btn.config(text="Остановить" if running else "Запустить", bg=FIELD if running else ACCENT)
        if c and c.url and status == "online":
            url_var.set(c.url)
            url_lbl.config(fg=ACCENT, cursor="hand2")
            copy_btn.config(state="normal")
        else:
            url_var.set("Ссылка появится после запуска" if status in ("idle", "error") else "Подключаюсь к relay…")
            url_lbl.config(fg=MUTED, cursor="arrow")
            copy_btn.config(state="disabled")
        if c and c.error and status in ("error", "offline"):
            error_lbl.config(text=c.error, fg=RED if status == "error" else ORANGE)
        elif status == "online":
            error_lbl.config(text="")
        if c:
            s = c.stats
            stats_lbl.config(text="Соединений: %d (сейчас %d)   ↓ %s   ↑ %s" %
                             (s["total"], s["active"], human(s["rx"]), human(s["tx"])))

    def poll():
        changed = False
        while True:
            try:
                kind, data = events.get_nowait()
            except queue.Empty:
                break
            changed = True
            if kind == "request":
                if state["log"] == 0:
                    log.delete(0, "end")
                state["log"] += 1
                log.insert(0, "%s  %-6s %s" % (time.strftime("%H:%M:%S"), data[0], data[1]))
                if log.size() > 300:
                    log.delete(300, "end")
        if changed:
            refresh()
        root.after(150, poll)

    def on_close():
        stop()
        root.after(200, root.destroy)

    root.protocol("WM_DELETE_WINDOW", on_close)
    if cfg.get("key") and cfg.get("autostart"):
        start()
    poll()
    refresh()
    root.mainloop()
    return 0


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    argv = sys.argv[1:]
    if argv and argv[0] == "http":           # совместимость с привычным «ngrok http 8080»
        argv = argv[1:]
    cfg = load_config()
    if not argv:
        if sys.platform == "win32" and getattr(sys, "frozen", False):
            try:                              # окно без чёрной консоли сзади
                import ctypes
                ctypes.windll.kernel32.FreeConsole()
            except Exception:
                pass
        return run_gui(cfg)
    p = argparse.ArgumentParser(prog="TabTunnel", description="Открыть локальный порт в интернет через свой relay")
    p.add_argument("port", type=int, help="локальный порт, например 8080")
    p.add_argument("--key", help="ключ подключения tabtunnel://секрет@адрес-relay (запоминается)")
    p.add_argument("--name", help="желаемое имя: https://имя.домен-relay")
    return run_cli(p.parse_args(argv), cfg)


if __name__ == "__main__":
    sys.exit(main())
