"""HTTP-часть: регистрация и вход, загрузка и раздача файлов, WebSocket, статика."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from urllib.parse import quote, unquote

from aiohttp import WSMsgType, web

from . import security
from .assets import Assets
from .version import PROTOCOL, VERSION
from .hub import (COLORS, Conn, Hub, RpcError, validate_auth, validate_identity, validate_kdf, validate_name,
                  validate_username)

DEFAULT_KDF_ITERS = 310_000
LOGIN_LIMIT, LOGIN_WINDOW = 8, 15 * 60      # столько неудачных входов в аккаунт за 15 минут — потом пауза

MAX_UPLOAD = 200 * 1024 * 1024
MEDIA_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
# что можно показывать прямо в браузере; всё остальное отдаётся только как скачивание
INLINE_PREFIXES = ("image/", "audio/", "video/")
INLINE_BLOCK = ("image/svg",)

def json_error(text, status=400):
    return web.json_response({"error": text}, status=status)


def make_app(db, static_dir, media_dir, client_exe=None):
    """client_exe — путь к приложению TabChat.exe рядом с сервером: его можно скачать по /download/windows."""
    hub = Hub(db)
    os.makedirs(media_dir, exist_ok=True)
    assets = Assets(static_dir)
    # постоянный идентификатор сервера (не раскрывает секрет): по нему приложение узнаёт сервер, даже если
    # у того сменился адрес, и не путает аккаунты разных серверов
    hub.server_id = hashlib.sha256(("tabchat-server-id:" + db.secret()).encode()).hexdigest()[:16]
    if client_exe and os.path.isfile(client_exe):
        hub.client_app = {"size": os.path.getsize(client_exe)}

    def bearer_user(request):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        s = db.session(security.token_hash(auth[7:].strip()))
        return s["user_id"] if s else None

    async def read_json(request):
        try:
            data = await request.json()
            return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def issue_session(uid, request):
        token, th = security.new_token()
        db.create_session(uid, th, request.headers.get("User-Agent", ""))
        return token

    # ---------- аккаунты ----------
    # Пароль не покидает браузер: из него выводятся два ключа — «auth» для входа (его сервер хранит
    # в виде хэша) и ключ, которым зашифрована копия ключей переписки (его сервер не видит никогда).
    def fake_salt(username):
        """Соль для несуществующего имени — чтобы по prelogin нельзя было проверять, есть ли аккаунт."""
        digest = hmac.new(db.secret().encode(), username.lower().encode(), hashlib.sha256).digest()[:16]
        return base64.b64encode(digest).decode()

    async def prelogin(request):
        data = await read_json(request)
        user = db.user_by_username(str(data.get("username") or "").strip().lstrip("@"))
        if user and user["kdf"] == "legacy":
            return web.json_response({"kdf": "legacy"})
        if user:
            return web.json_response({"kdf": "v1", "salt": user["kdf_salt"], "iters": user["kdf_iters"]})
        return web.json_response({"kdf": "v1", "salt": fake_salt(str(data.get("username") or "")),
                                  "iters": DEFAULT_KDF_ITERS})

    async def register(request):
        data = await read_json(request)
        try:
            username = validate_username(data.get("username"))
            name = validate_name(data.get("name"))
            if "password" in data:
                raise RpcError("Страница устарела — обновите её (Ctrl+F5)")
            auth = validate_auth(data.get("auth"))
            salt, iters = validate_kdf(data.get("salt"), data.get("iters"))
            keys = validate_identity(data.get("keys"))
        except RpcError as e:
            return json_error(str(e))
        if db.user_by_username(username):
            return json_error("Этот @username уже занят", 409)
        pw_hash = await asyncio.get_running_loop().run_in_executor(None, security.hash_password, auth)
        uid = db.create_user(username, name, COLORS[secrets.randbelow(len(COLORS))], pw_hash,
                             kdf="v1", kdf_salt=salt, kdf_iters=iters, **keys)
        return web.json_response({"token": issue_session(uid, request), "user": hub.pub_id(uid)})

    login_fails = {}                        # имя → время неудачных попыток (в памяти, на перезапуск хватает)

    async def login(request):
        data = await read_json(request)
        name = str(data.get("username") or "").strip().lstrip("@").lower()[:64]
        now = time.monotonic()
        fails = [t for t in login_fails.get(name, []) if now - t < LOGIN_WINDOW]
        login_fails[name] = fails
        if len(fails) >= LOGIN_LIMIT:
            wait = int((LOGIN_WINDOW - (now - fails[0])) / 60) + 1
            return json_error("Слишком много неудачных попыток входа. Попробуйте через %d мин." % wait, 429)
        user = db.user_by_username(name)
        loop = asyncio.get_running_loop()
        ok = False
        try:
            if user and user["kdf"] == "v1":
                ok = await loop.run_in_executor(None, security.check_password,
                                                validate_auth(data.get("auth")), user["pw_hash"])
            elif user:
                # старый аккаунт: последний вход обычным паролем, сразу переходим на новую схему
                if not isinstance(data.get("upgrade"), dict):
                    raise RpcError("Страница устарела — обновите её (Ctrl+F5)")
                ok = await loop.run_in_executor(None, security.check_password,
                                                str(data.get("password") or ""), user["pw_hash"])
                if ok:
                    await hub.apply_upgrade(user["id"], data.get("upgrade") or {})
        except RpcError as e:
            return json_error(str(e))
        if not ok:
            login_fails.setdefault(name, []).append(time.monotonic())
            await asyncio.sleep(0.4)  # притормаживаем перебор
            return json_error("Неверное имя пользователя или пароль", 401)
        user = db.user(user["id"])
        return web.json_response({"token": issue_session(user["id"], request), "user": hub.pub(user),
                                  "backup": json.loads(user["key_backup"]) if user["key_backup"] else None})

    async def logout(request):
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            th = security.token_hash(auth[7:].strip())
            db.delete_session(th)
            await hub.close_session(th)
        return web.json_response({"ok": True})

    async def check_username(request):
        name = request.query.get("u", "").lstrip("@")
        return web.json_response({"free": not db.user_by_username(name)})

    # ---------- файлы ----------
    async def upload(request):
        uid = bearer_user(request)
        if not uid:
            return json_error("Нужно войти", 401)
        name = unquote(request.headers.get("X-File-Name", "file"))[:200] or "file"
        mime = (request.headers.get("Content-Type") or "application/octet-stream")[:120]
        mid = secrets.token_urlsafe(18)
        path = os.path.join(media_dir, mid)
        size = 0
        try:
            with open(path, "wb") as f:
                async for chunk in request.content.iter_chunked(256 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise ValueError("too big")
                    f.write(chunk)
        except ValueError:
            os.remove(path)
            return json_error("Файл больше 200 МБ", 413)
        except Exception:
            if os.path.exists(path):
                os.remove(path)
            raise
        if size == 0:
            os.remove(path)
            return json_error("Пустой файл")
        db.add_media(mid, uid, mime, size, name)
        return web.json_response({"id": mid, "mime": mime, "size": size, "name": name})

    async def media(request):
        mid = request.match_info["id"]
        if not MEDIA_ID_RE.match(mid):
            raise web.HTTPNotFound()
        row = db.media(mid)
        path = os.path.join(media_dir, mid)
        if not row or not os.path.exists(path):
            raise web.HTTPNotFound()
        mime = row["mime"]
        inline = mime.startswith(INLINE_PREFIXES) and not mime.startswith(INLINE_BLOCK) and "dl" not in request.query
        headers = {
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
            "Content-Disposition": "%s; filename*=UTF-8''%s" % ("inline" if inline else "attachment", quote(row["name"])),
        }
        resp = web.FileResponse(path, headers=headers)
        resp.content_type = mime.split(";")[0] if inline else "application/octet-stream"
        return resp

    # ---------- WebSocket ----------
    async def ws_handler(request):
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=2 * 1024 * 1024)
        await ws.prepare(request)
        conn = None
        try:
            async for raw in ws:
                if raw.type != WSMsgType.TEXT:
                    continue
                try:
                    msg = json.loads(raw.data)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if conn is None:
                    # первое сообщение обязано быть авторизацией
                    token = str((msg.get("p") or {}).get("token") or "") if msg.get("m") == "auth" else ""
                    th = security.token_hash(token)
                    s = db.session(th) if token else None
                    if not s:
                        await ws.send_str(json.dumps({"id": msg.get("id"), "err": "auth"}))
                        await ws.close(code=4001, message=b"auth")
                        break
                    conn = Conn(ws, s["user_id"], th)
                    await hub.connect(conn)
                    await conn.send({"id": msg.get("id"), "ok": {"conn": conn.id}})
                    continue
                await hub.dispatch(conn, msg)
        finally:
            if conn:
                await hub.disconnect(conn)
        return ws

    # ---------- о сервере и приложение для Windows ----------
    async def info(request):
        return web.json_response({"app": "TabChat", "version": VERSION, "protocol": PROTOCOL,
                                  "server_id": hub.server_id, "public_url": hub.public_url,
                                  "client_app": hub.client_app})

    async def download_client(request):
        if not hub.client_app:
            raise web.HTTPNotFound()
        resp = web.FileResponse(client_exe, headers={"Content-Disposition": 'attachment; filename="TabChat.exe"',
                                                     "Cache-Control": "no-cache"})
        resp.content_type = "application/vnd.microsoft.portable-executable"
        return resp

    @web.middleware
    async def headers_mw(request, handler):
        resp = await handler(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        return resp

    app = web.Application(middlewares=[headers_mw], client_max_size=4 * 1024 * 1024)
    app["hub"] = hub

    async def close_hub(app):
        await hub.close()
    app.on_cleanup.append(close_hub)
    assets.add_routes(app)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/info", info)
    app.router.add_get("/download/windows", download_client)
    app.router.add_post("/api/register", register)
    app.router.add_post("/api/login", login)
    app.router.add_post("/api/prelogin", prelogin)
    app.router.add_post("/api/logout", logout)
    app.router.add_get("/api/username", check_username)
    app.router.add_post("/api/upload", upload)
    app.router.add_get("/media/{id}", media)
    return app
