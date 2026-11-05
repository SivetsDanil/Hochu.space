"""Статика веб-клиента: из памяти, сжатая gzip, с версиями файлов и index.html с картой импортов.

Ей пользуются и сервер (раздаёт веб-клиент браузерам), и приложение TabChat.exe — у него свой,
встроенный клиент, поэтому сервер не может подменить код, которым шифруется переписка.
"""
import base64
import gzip
import hashlib
import json
import mimetypes
import os

from aiohttp import web

# в Windows реестр иногда отдаёт text/plain для .js — тогда ES-модули не грузятся, поэтому типы задаём сами
CONTENT_TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                 ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json"}
COMPRESSIBLE = (".js", ".css", ".html", ".svg", ".json", ".webmanifest")
FOREVER = "public, max-age=31536000, immutable"


def csp(script_hash, host):
    """Политика страницы: скрипты — только наши файлы и карта импортов. Даже если в сообщение каким-то образом
    пролезет разметка, чужой скрипт не выполнится и не утащит ключи. Картинки карты — с серверов OpenStreetMap."""
    return "; ".join([
        "default-src 'self'",
        "script-src 'self' 'sha256-%s'" % script_hash,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://tile.openstreetmap.org",
        "media-src 'self' blob:",
        "connect-src 'self' blob: ws://%s wss://%s" % (host, host),
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ])


class Assets:
    """Через туннель каждый запрос стоит полсекунды, поэтому файлы с ?v=хэш браузер кэширует навсегда:
    при повторном открытии код не скачивается вообще, а после обновления программы хэш меняется
    и браузер берёт новую версию."""

    def __init__(self, root):
        self.root = os.path.realpath(root)
        self.cache = {}
        self.index_cache = {}

    def get(self, rel):
        path = os.path.realpath(os.path.join(self.root, rel))
        if not path.startswith(self.root + os.sep) or not os.path.isfile(path):
            return None
        st = os.stat(path)
        e = self.cache.get(path)
        if e and (e["mtime"], e["size"]) == (st.st_mtime_ns, st.st_size):
            return e                      # файл не менялся (при запуске из исходников его можно править на ходу)
        with open(path, "rb") as f:
            data = f.read()
        ext = os.path.splitext(path)[1].lower()
        e = {"mtime": st.st_mtime_ns, "size": st.st_size, "data": data,
             "hash": hashlib.sha256(data).hexdigest()[:12],
             "type": CONTENT_TYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream",
             "gz": gzip.compress(data, 9, mtime=0) if ext in COMPRESSIBLE and len(data) > 512 else None}
        self.cache[path] = e
        return e

    def version(self, rel):
        e = self.get(rel)
        return e["hash"] if e else "0"

    @staticmethod
    def respond(request, data, gz, etag, cache, content_type):
        headers = {"ETag": etag, "Cache-Control": cache, "Vary": "Accept-Encoding", "Content-Type": content_type}
        if etag in request.headers.get("If-None-Match", ""):
            return web.Response(status=304, headers=headers)
        if gz and "gzip" in request.headers.get("Accept-Encoding", ""):
            data = gz
            headers["Content-Encoding"] = "gzip"
        return web.Response(body=data, headers=headers)

    def index_page(self):
        """index.html с версиями файлов: карта импортов подставляет ?v=хэш даже во вложенные import './x.js',
        а modulepreload качает все модули сразу, а не цепочкой «main.js → его импорты → их импорты»."""
        js = sorted(f for f in os.listdir(os.path.join(self.root, "js")) if f.endswith(".js"))
        imports = {"/static/js/" + f: "/static/js/%s?v=%s" % (f, self.version("js/" + f)) for f in js}
        key = (self.version("index.html"), self.version("css/app.css"), tuple(imports.values()))
        page = self.index_cache
        if page.get("key") != key:
            html = self.get("index.html")["data"].decode("utf-8")
            html = html.replace('href="/static/css/app.css"', 'href="/static/css/app.css?v=%s"' % key[1])
            html = html.replace('src="/static/js/main.js"', 'src="%s"' % imports["/static/js/main.js"])
            importmap = json.dumps({"imports": imports})
            head = '  <script type="importmap">%s</script>\n' % importmap
            head += "".join('  <link rel="modulepreload" href="%s">\n' % u for u in imports.values())
            html = html.replace("</head>", head + "</head>").encode("utf-8")
            # единственный встроенный скрипт — карта импортов; разрешаем ровно его по хэшу
            page["script_hash"] = base64.b64encode(hashlib.sha256(importmap.encode("utf-8")).digest()).decode()
            page.update(key=key, data=html, gz=gzip.compress(html, 9, mtime=0),
                        etag='"%s"' % hashlib.sha256(html).hexdigest()[:12])
        return page

    # ---------- обработчики ----------
    async def h_index(self, request):
        page = self.index_page()
        resp = self.respond(request, page["data"], page["gz"], page["etag"], "no-cache", CONTENT_TYPES[".html"])
        resp.headers["Content-Security-Policy"] = csp(page["script_hash"], request.host)
        return resp

    async def h_static(self, request):
        e = self.get(request.match_info["path"])
        if not e:
            raise web.HTTPNotFound()
        cache = FOREVER if request.query.get("v") == e["hash"] else "no-cache"
        return self.respond(request, e["data"], e["gz"], '"%s"' % e["hash"], cache, e["type"])

    def plain(self, name):
        """Файл из корня статики без версии (service worker и манифест обязаны жить по постоянному адресу)."""
        async def handler(request):
            e = self.get(name)
            if not e:
                raise web.HTTPNotFound()
            return self.respond(request, e["data"], e["gz"], '"%s"' % e["hash"], "no-cache", e["type"])
        return handler

    def add_routes(self, app):
        app.router.add_get("/", self.h_index)
        app.router.add_get("/join/{code}", self.h_index)
        app.router.add_get("/static/{path:.+}", self.h_static)
        app.router.add_get("/sw.js", self.plain("sw.js"))
        app.router.add_get("/manifest.webmanifest", self.plain("manifest.webmanifest"))
