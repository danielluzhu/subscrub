#!/usr/bin/env python3
"""Generate the Subscrub extension icons (no third-party deps).

Draws a rounded orange tile with a white "blocked" symbol, supersampled 4x
for smooth edges, and writes PNGs into ../icons.

    python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

BG_TOP = (255, 96, 32)
BG_BOT = (222, 48, 0)
FG = (255, 255, 255)
SS = 4  # supersample factor

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')


def inside_rounded_square(x, y, size, radius):
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def sample(x, y, size):
    if not inside_rounded_square(x, y, size, size * 0.22):
        return (0, 0, 0, 0)

    t = y / size
    bg = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))

    c = size / 2.0
    dx, dy = x - c, y - c
    dist = math.hypot(dx, dy)
    ring_r = size * 0.30
    thick = size * 0.088

    on_ring = abs(dist - ring_r) <= thick / 2
    on_bar = abs((dx + dy) / math.sqrt(2)) <= thick / 2 and dist <= ring_r + thick / 2
    if on_ring or on_bar:
        return FG + (255,)
    return bg + (255,)


def render(size):
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    r, g, b, a = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS, size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            alpha = acc[3] / (SS * SS)
            if acc[3] > 0:
                row.extend([int(acc[0] / acc[3]), int(acc[1] / acc[3]),
                            int(acc[2] / acc[3]), int(round(alpha))])
            else:
                row.extend([0, 0, 0, 0])
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b''.join(b'\x00' + row for row in rows)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(png)


def main():
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, 'icon%d.png' % size)
        write_png(path, render(size), size)
        print('wrote', os.path.normpath(path))


if __name__ == '__main__':
    main()
