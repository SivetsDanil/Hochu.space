"""Окно TabChat Server вместо консоли: ссылка для друзей, кнопки, кто онлайн и журнал.

Сервер работает в отдельном потоке со своим циклом asyncio, окно (tkinter) — в главном.
Всё, что сервер и туннель печатают через print(), попадает в журнал окна и в data/server.log.
"""
import asyncio
import os
import queue
import subprocess
import sys
import threading
import time
import webbrowser

BG, CARD, FIELD, TEXT, MUTED, ACCENT, GREEN, RED, ORANGE = (
    "#0e1621", "#17212b", "#202b36", "#e8eef4", "#7d8e9e", "#5eb5f7", "#4fce6e", "#ec5b56", "#f0a43a")


class LogWriter:
    """Подменяет sys.stdout: строки — в очередь для окна и в файл журнала."""

    encoding = "utf-8"

    def __init__(self, events, path):
        self.events = events
        self.buf = ""
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if os.path.exists(path) and os.path.getsize(path) > 2 * 1024 * 1024:
                os.replace(path, path + ".old")
            self.file = open(path, "a", encoding="utf-8")
        except OSError:
            self.file = None

    def write(self, s):
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            line = line.rstrip()
            if not line.strip() or set(line.strip()) == {"="}:
                continue
            self.events.put(("log", time.strftime("%H:%M  ") + " ".join(line.split())))
            if self.file:
                self.file.write(time.strftime("%Y-%m-%d %H:%M:%S ") + line.strip() + "\n")
                self.file.flush()
        return len(s)

    def flush(self):
        pass


def run_gui(args, run, data_dir):
    import tkinter as tk
    from tkinter import messagebox

    if sys.platform == "win32":
        try:                                   # чёткий текст на экранах с масштабом 125–200%
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass

    events = queue.Queue()
    sys.stdout = sys.stderr = LogWriter(events, os.path.join(data_dir, "server.log"))
    holder = {}

    async def serve():
        holder["loop"] = asyncio.get_running_loop()
        holder["stop"] = asyncio.Event()
        await run(args, stop=holder["stop"], on_ready=lambda st: events.put(("ready", st)))

    def worker():
        try:
            asyncio.run(serve())
        except Exception as e:  # порт, вторая копия сервера и т. п. — показываем в окне
            print("Сервер не запустился: %s" % e)
            events.put(("error", str(e)))
        finally:
            events.put(("stopped", None))

    threading.Thread(target=worker, daemon=True).start()

    # ---------- окно ----------
    root = tk.Tk()
    root.title("TabChat Server")
    scale = root.winfo_fpixels("1i") / 96
    root.geometry("%dx%d" % (500 * scale, 680 * scale))
    root.minsize(int(440 * scale), int(560 * scale))
    root.configure(bg=BG)
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    try:
        root.iconphoto(True, tk.PhotoImage(file=os.path.join(base, "static", "icons", "icon-192.png")))
    except tk.TclError:
        pass

    def label(parent, text="", size=10, color=TEXT, bold=False, **kw):
        return tk.Label(parent, text=text, bg=parent["bg"], fg=color,
                        font=("Segoe UI Semibold" if bold else "Segoe UI", size), **kw)

    def button(parent, text, command, primary=False):
        return tk.Button(parent, text=text, command=command, bg=ACCENT if primary else FIELD,
                         fg="#ffffff" if primary else TEXT, activebackground="#3e8fd6" if primary else CARD,
                         activeforeground="#ffffff", relief="flat", bd=0, padx=14, pady=6, cursor="hand2",
                         font=("Segoe UI Semibold" if primary else "Segoe UI", 10))

    head = tk.Frame(root, bg=BG)
    head.pack(fill="x", padx=20, pady=(18, 10))
    label(head, "TabChat Server", 16, bold=True).pack(side="left")
    status_lbl = label(head, "● Запускается…", 10, ORANGE)
    status_lbl.pack(side="right")

    # ссылка для друзей
    card = tk.Frame(root, bg=CARD, padx=16, pady=14)
    card.pack(fill="x", padx=20)
    label(card, "Ссылка для друзей — работает из любой сети", 9, MUTED, anchor="w").pack(fill="x")
    url_lbl = label(card, "Получаю ссылку…", 13, MUTED, bold=True, anchor="w", justify="left",
                    wraplength=int(430 * scale))
    url_lbl.pack(fill="x", pady=(4, 2))
    note_lbl = label(card, "", 9, MUTED, anchor="w", justify="left", wraplength=int(430 * scale))
    note_lbl.pack(fill="x")
    row = tk.Frame(card, bg=CARD)
    row.pack(fill="x", pady=(10, 0))
    copy_btn = button(row, "Копировать", lambda: copy_link(), primary=True)
    copy_btn.pack(side="left")
    open_btn = button(row, "Открыть в браузере", lambda: webbrowser.open(state["link"]) if state.get("link") else None)
    open_btn.pack(side="left", padx=(8, 0))

    # этот компьютер и сеть
    local = tk.Frame(root, bg=CARD, padx=16, pady=14)
    local.pack(fill="x", padx=20, pady=(12, 0))
    label(local, "На этом компьютере", 9, MUTED, anchor="w").pack(fill="x")
    app_btn = button(local, "Открыть TabChat", lambda: open_client(), primary=True)
    app_btn.pack(anchor="w", pady=(6, 6))
    lan_lbl = label(local, "", 9, MUTED, anchor="w", justify="left", wraplength=int(430 * scale))
    lan_lbl.pack(fill="x")

    stats = tk.Frame(root, bg=BG)
    stats.pack(fill="x", padx=20, pady=(12, 4))
    online_lbl = label(stats, "", 10, TEXT, anchor="w")
    online_lbl.pack(side="left")
    folder_btn = tk.Label(stats, text="Папка с данными", bg=BG, fg=ACCENT, cursor="hand2", font=("Segoe UI", 9))
    folder_btn.pack(side="right")
    folder_btn.bind("<Button-1>", lambda e: os.startfile(data_dir) if sys.platform == "win32" else None)

    log_frame = tk.Frame(root, bg=CARD)
    log_frame.pack(fill="both", expand=True, padx=20, pady=(4, 18))
    log = tk.Listbox(log_frame, bg=CARD, fg=MUTED, font=("Consolas", 9), relief="flat", bd=0,
                     highlightthickness=0, selectbackground=FIELD, activestyle="none")
    log.pack(fill="both", expand=True, padx=10, pady=8)

    state = {"ready": None, "link": None, "stopped": False, "closing": False}

    def copy_link():
        if not state["link"]:
            return
        root.clipboard_clear()
        root.clipboard_append(state["link"])
        copy_btn.config(text="Скопировано ✓")
        root.after(1500, lambda: copy_btn.config(text="Копировать"))

    def open_client():
        st = state["ready"]
        if not st:
            return
        local_url = "http://localhost:%d" % st["http_port"]
        if st["client_exe"]:
            subprocess.Popen([st["client_exe"], local_url], close_fds=True)
        else:
            webbrowser.open(local_url)

    def refresh():
        st = state["ready"]
        if state["stopped"]:
            return
        if not st:
            return
        hub = st["hub"]
        url, kind = hub.public_url, hub.tunnel_kind
        lan = "https://%s:%d" % (st["ips"][0], st["https_port"]) if st["ips"] and st["https_port"] else None
        link = url or lan
        if link != state["link"]:
            state["link"] = link
            url_lbl.config(text=link or "Нет ссылки", fg=ACCENT if link else MUTED, cursor="hand2" if link else "arrow")
        if url:
            note_lbl.config(text={"free": "Постоянная ссылка — её можно сохранить, после перезапуска она не изменится.",
                                  "temp": "Ссылка меняется при каждом запуске сервера — после перезапуска отправьте друзьям новую.",
                                  "relay": "Адрес на вашем relay — постоянный."}.get(kind, ""), fg=MUTED)
        elif st["tunnel"]:
            note_lbl.config(text="Туннель в интернет подключается… Пока работает ссылка для домашней сети.", fg=ORANGE)
        else:
            note_lbl.config(text="Туннель в интернет выключен — ссылка работает только в вашей сети.", fg=MUTED)
        copy_btn.config(state="normal" if link else "disabled")
        open_btn.config(state="normal" if link else "disabled")
        online_lbl.config(text="Сейчас онлайн: %d" % len(hub.by_user))
        lan_parts = []
        if st["ips"]:
            lan_parts.append("В домашней сети: http://%s:%d — для приложения" % (st["ips"][0], st["http_port"]))
            if st["https_port"]:
                lan_parts.append("https://%s:%d — для браузера" % (st["ips"][0], st["https_port"]))
        lan_lbl.config(text="\n".join(lan_parts))
        app_btn.config(text="Открыть TabChat" if st["client_exe"] else "Открыть TabChat в браузере")

    url_lbl.bind("<Button-1>", lambda e: webbrowser.open(state["link"]) if state["link"] else None)

    def poll():
        while True:
            try:
                kind, data = events.get_nowait()
            except queue.Empty:
                break
            if kind == "log":
                log.insert("end", data)
                if log.size() > 500:
                    log.delete(0, log.size() - 500)
                log.see("end")
            elif kind == "ready":
                state["ready"] = data
                status_lbl.config(text="● Работает", fg=GREEN)
            elif kind == "error":
                status_lbl.config(text="● Ошибка", fg=RED)
                url_lbl.config(text="Сервер не запустился", fg=RED)
                note_lbl.config(text=data, fg=RED)
                copy_btn.config(state="disabled")
                open_btn.config(state="disabled")
                app_btn.config(state="disabled")
            elif kind == "stopped":
                state["stopped"] = True
                if state["closing"]:
                    root.destroy()
                    return
                if status_lbl.cget("text") != "● Ошибка":
                    status_lbl.config(text="● Остановлен", fg=MUTED)
        refresh()
        root.after(400, poll)

    def on_close():
        if state["stopped"]:
            root.destroy()
            return
        if state["ready"] and len(state["ready"]["hub"].by_user) and not messagebox.askyesno(
                "TabChat Server", "Остановить сервер? Все, кто сейчас в TabChat, потеряют связь."):
            return
        state["closing"] = True
        status_lbl.config(text="● Останавливается…", fg=ORANGE)
        if holder.get("stop"):
            holder["loop"].call_soon_threadsafe(holder["stop"].set)
        root.after(6000, root.destroy)           # не дождались — всё равно закрываемся

    root.protocol("WM_DELETE_WINDOW", on_close)
    poll()
    root.mainloop()
