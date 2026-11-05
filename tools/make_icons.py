"""Рисует иконки: PNG для веба (192/512), .ico для exe TabChat и TabTunnel.

Без сторонних библиотек: простой растеризатор со сглаживанием.
Запуск:  .venv\\Scripts\\python tools\\make_icons.py
"""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "static", "icons")
TUNNEL = os.path.join(ROOT, "tunnel")


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def in_round_rect(x, y, rx, ry, w, hgt, r):
    if x < rx or y < ry or x > rx + w or y > ry + hgt:
        return False
    cx = min(max(x, rx + r), rx + w - r)
    cy = min(max(y, ry + r), ry + hgt - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(x, y, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1, d2, d3 = sign((x, y), a, b), sign((x, y), b, c), sign((x, y), c, a)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


WHITE = (255, 255, 255)


def gradient(x, y, top, bottom):
    t = (x + y) / 128
    return tuple(top[i] + (bottom[i] - top[i]) * t for i in range(3))


def blend(col, c, a):
    return tuple(col[i] * (1 - a) + c[i] * a for i in range(3))


def chat_shade(x, y):
    """TabChat: вкладки над облачком сообщения."""
    if not in_round_rect(x, y, 0, 0, 64, 64, 16):
        return None
    blue = hex_rgb("#2f7fd4")
    col = gradient(x, y, hex_rgb("#5eb5f7"), blue)
    if in_round_rect(x, y, 13, 15, 16, 7, 3.5):
        col = blend(col, WHITE, 1)
    if in_round_rect(x, y, 31, 15, 20, 7, 3.5):
        col = blend(col, WHITE, .55)
    if in_round_rect(x, y, 13, 25, 38, 22, 4) or in_triangle(x, y, (19, 46), (27, 46), (19, 53)):
        col = blend(col, WHITE, 1)
        if in_round_rect(x, y, 20, 32, 18, 3.4, 1.7):
            col = blend(col, blue, 1)
        if in_round_rect(x, y, 20, 38, 12, 3.4, 1.7):
            col = blend(col, blue, .6)
    return col


def tunnel_shade(x, y):
    """TabTunnel: арка туннеля и стрелка сквозь неё."""
    if not in_round_rect(x, y, 0, 0, 64, 64, 16):
        return None
    col = gradient(x, y, hex_rgb("#4fce9e"), hex_rgb("#1f8a8a"))
    d = ((x - 32) ** 2 + (y - 38) ** 2) ** 0.5
    arch = (y <= 38 and 15 <= d <= 23) or in_round_rect(x, y, 9, 37, 8, 13, 1.5) or in_round_rect(x, y, 47, 37, 8, 13, 1.5)
    if arch:
        col = blend(col, WHITE, 1)
    if in_round_rect(x, y, 20, 36.5, 16, 5, 2.5) or in_triangle(x, y, (34, 30), (45, 39), (34, 48)):
        col = blend(col, WHITE, .92)
    return col


def render(shade, size, ss=3):
    rows = []
    k = 64 / size
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0.0, 0.0, 0.0]
            cover = 0
            for sy in range(ss):
                for sx in range(ss):
                    c = shade((px + (sx + .5) / ss) * k, (py + (sy + .5) / ss) * k)
                    if c:
                        cover += 1
                        for i in range(3):
                            acc[i] += c[i]
            if cover:
                row += bytes(int(round(acc[i] / cover)) for i in range(3)) + bytes([round(255 * cover / ss / ss)])
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def png_bytes(size, rows):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(os.path.relpath(path, ROOT))


def ico_bytes(images):
    """ICO с PNG внутри (Windows Vista+): [(size, png_bytes), ...]."""
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    return header + entries + blobs


def make(shade, sizes_png, ico_path, png_paths):
    pngs = {}
    for size in sorted(set(sizes_png) | {16, 32, 48, 256}):
        pngs[size] = png_bytes(size, render(shade, size, 4 if size <= 48 else 3 if size <= 256 else 2))
    for size, path in png_paths.items():
        write(path, pngs[size])
    write(ico_path, ico_bytes([(s, pngs[s]) for s in (16, 32, 48, 256)]))


if __name__ == "__main__":
    make(chat_shade, [192, 512], os.path.join(WEB, "app.ico"),
         {192: os.path.join(WEB, "icon-192.png"), 512: os.path.join(WEB, "icon-512.png")})
    make(tunnel_shade, [256], os.path.join(TUNNEL, "icon.ico"), {256: os.path.join(TUNNEL, "icon.png")})
