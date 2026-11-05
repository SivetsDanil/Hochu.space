"""Сквозная проверка TabTunnel: relay + клиенты + локальные серверы в одном процессе.

Запуск:  .venv\\Scripts\\python tunnel\\tests\\test_tunnel.py
"""
import asyncio
import hashlib
import os
import sys

import aiohttp
from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))                       # tunnel/  → tabtunnel
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "relay"))  # tunnel/relay → relay
import relay as relay_mod  # noqa: E402
from tabtunnel import TunnelClient  # noqa: E402

TOKEN = "test-token-123"
BIG = os.urandom(3 * 1024 * 1024)


def make_app(label):
    async def hello(request):
        return web.Response(text="hello from " + label)

    async def echo(request):
        h = hashlib.sha256()
        size = 0
        async for chunk in request.content.iter_chunked(65536):
            h.update(chunk)
            size += len(chunk)
        return web.json_response({"size": size, "sha": h.hexdigest()})

    async def big(request):
        return web.Response(body=BIG)

    async def ws(request):
        sock = web.WebSocketResponse()
        await sock.prepare(request)
        async for msg in sock:
            await sock.send_str(label + ":" + msg.data)
        return sock

    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.router.add_get("/hello", hello)
    app.router.add_post("/echo", echo)
    app.router.add_get("/big", big)
    app.router.add_get("/ws", ws)
    return app


async def start_app(app):
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, site._server.sockets[0].getsockname()[1]


async def wait_status(client, status, timeout=10):
    for _ in range(int(timeout * 20)):
        if client.status == status:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("клиент не дошёл до статуса %s (сейчас %s, %s)" % (status, client.status, client.error))


async def main():
    # ---------- relay в режиме «много туннелей» ----------
    args = relay_mod.parse_args(["--listen", "127.0.0.1", "--port", "0", "--token", TOKEN,
                                 "--domain", "tun.test", "--scheme", "http",
                                 "--turn-url", "turn:1.2.3.4:3478", "--turn-secret", "s3cr3t"])
    relay = relay_mod.Relay(args)
    server = await asyncio.start_server(relay.on_connection, "127.0.0.1", 0, limit=relay_mod.MAX_HEAD)
    rport = server.sockets[0].getsockname()[1]
    base = "http://127.0.0.1:%d" % rport

    runner_a, port_a = await start_app(make_app("A"))
    runner_b, port_b = await start_app(make_app("B"))

    key = "tabtunnel+ws://%s@127.0.0.1:%d" % (TOKEN, rport)
    seen = []
    ca = TunnelClient(key, port_a, name="alpha", on_request=lambda m, p: seen.append((m, p)))
    cb = TunnelClient(key + "/beta", port_b)
    ta, tb = asyncio.ensure_future(ca.run()), asyncio.ensure_future(cb.run())
    await wait_status(ca, "online")
    await wait_status(cb, "online")
    assert ca.url == "http://alpha.tun.test", ca.url
    assert cb.url == "http://beta.tun.test", cb.url
    assert ca.turn == {"urls": ["turn:1.2.3.4:3478"], "secret": "s3cr3t"}
    print("✓ клиенты подключились, ссылки:", ca.url, cb.url)

    async with aiohttp.ClientSession() as s:
        async def get(host, path):
            async with s.get(base + path, headers={"Host": host}) as r:
                return r.status, await r.read()

        st, body = await get("alpha.tun.test", "/hello")
        assert (st, body) == (200, b"hello from A"), (st, body)
        st, body = await get("beta.tun.test", "/hello")
        assert (st, body) == (200, b"hello from B"), (st, body)
        st, body = await get("gamma.tun.test", "/hello")
        assert st == 502 and "не подключён".encode() in body
        print("✓ маршрутизация по имени: alpha → A, beta → B, неизвестное имя → 502")

        payload = os.urandom(5 * 1024 * 1024 + 123)
        async with s.post(base + "/echo", data=payload, headers={"Host": "alpha.tun.test"}) as r:
            res = await r.json()
        assert res == {"size": len(payload), "sha": hashlib.sha256(payload).hexdigest()}, res
        st, body = await get("beta.tun.test", "/big")
        assert st == 200 and body == BIG
        print("✓ загрузка 5 МБ и скачивание 3 МБ через туннель — байт в байт")

        results = await asyncio.gather(*[get("alpha.tun.test", "/hello") for _ in range(30)])
        assert all(r == (200, b"hello from A") for r in results)
        print("✓ 30 параллельных запросов")

        async with s.ws_connect(base + "/ws", headers={"Host": "beta.tun.test"}) as ws:
            for i in range(5):
                await ws.send_str("ping%d" % i)
                msg = await ws.receive(timeout=5)
                assert msg.data == "B:ping%d" % i, msg.data
        print("✓ WebSocket через туннель")

        assert ("GET", "/hello") in seen and ("POST", "/echo") in seen
        print("✓ журнал запросов у клиента:", len(seen), "записей")

        async with s.get(base + "/_tunnel/ask", params={"domain": "alpha.tun.test"}) as r:
            assert r.status == 200
        async with s.get(base + "/_tunnel/ask", params={"domain": "nope.tun.test"}) as r:
            assert r.status == 404
        print("✓ проверка имён для сертификатов (on-demand TLS)")

        # локальный сервер выключен — посетитель видит понятную страницу
        await runner_b.cleanup()
        st, body = await get("beta.tun.test", "/hello")
        assert st == 502 and "Сервер не отвечает".encode() in body, (st, body[:200])
        print("✓ локальный сервер выключен → страница 502 от клиента")

    # неверный ключ — клиент не долбится бесконечно
    bad = TunnelClient("tabtunnel+ws://wrong@127.0.0.1:%d" % rport, port_a, name="evil")
    tbad = asyncio.ensure_future(bad.run())
    await wait_status(bad, "error")
    assert "Неверный ключ" in bad.error
    await tbad
    # чужое имя занять нельзя
    thief = TunnelClient(key, port_a, name="alpha")
    tthief = asyncio.ensure_future(thief.run())
    await wait_status(thief, "error")
    assert "занято" in thief.error
    await tthief
    print("✓ неверный ключ и занятое имя отклоняются")

    # переподключение: relay обрывает сессию — клиент возвращается сам
    relay.sessions["alpha"].close()
    for _ in range(100):
        if ca.status != "online":
            break
        await asyncio.sleep(0.05)
    assert ca.status != "online", "клиент не заметил обрыв"
    await wait_status(ca, "online", timeout=15)
    async with aiohttp.ClientSession() as s:
        async with s.get(base + "/hello", headers={"Host": "alpha.tun.test"}) as r:
            assert await r.text() == "hello from A"
    print("✓ клиент переподключается сам после обрыва")

    ca.stop()
    cb.stop()
    for t in (ta, tb):
        t.cancel()
    await runner_a.cleanup()
    server.close()

    # ---------- relay в режиме «один туннель» ----------
    args = relay_mod.parse_args(["--listen", "127.0.0.1", "--port", "0", "--token", TOKEN])
    relay1 = relay_mod.Relay(args)
    server1 = await asyncio.start_server(relay1.on_connection, "127.0.0.1", 0, limit=relay_mod.MAX_HEAD)
    rport1 = server1.sockets[0].getsockname()[1]
    runner_c, port_c = await start_app(make_app("C"))
    cc = TunnelClient("tabtunnel+ws://%s@127.0.0.1:%d" % (TOKEN, rport1), port_c)
    tc = asyncio.ensure_future(cc.run())
    await wait_status(cc, "online")
    assert cc.url == "http://127.0.0.1:%d" % rport1, cc.url
    async with aiohttp.ClientSession() as s:
        async with s.get("http://127.0.0.1:%d/hello" % rport1, headers={"Host": "anything.example"}) as r:
            assert await r.text() == "hello from C"
    print("✓ режим одного туннеля: любой адрес → единственный клиент")
    cc.stop()
    tc.cancel()
    await runner_c.cleanup()
    server1.close()
    print("\nВсе проверки туннеля пройдены")


if __name__ == "__main__":
    asyncio.run(main())
