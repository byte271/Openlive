#!/usr/bin/env python3
"""Generate placeholder OpenLive desktop icons (PNG, ICO, ICNS)."""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "icons"


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(width: int, height: int, rgba_at) -> bytes:
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(rgba_at(x, y, width, height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def orb_pixel(x: int, y: int, w: int, h: int) -> bytes:
    cx, cy = (w - 1) / 2, (h - 1) / 2
    nx = (x - cx) / max(cx, 1)
    ny = (y - cy) / max(cy, 1)
    r = math.hypot(nx, ny)
    # Transparent outside the orb so the dock icon is circular-ish.
    if r > 1.02:
        return b"\x00\x00\x00\x00"
    # Soft edge
    edge = max(0.0, min(1.0, (1.02 - r) / 0.08))
    # Light paper orb with two dark elliptical eyes (Bloub-ish).
    paper = (244, 244, 242)
    ink = (10, 10, 12)
    highlight = 1.0 - min(1.0, math.hypot(nx + 0.22, ny + 0.28) * 0.85)
    shade = min(1.0, r * 0.35)
    pr = int(paper[0] * (0.82 + 0.18 * highlight) * (1 - shade * 0.12))
    pg = int(paper[1] * (0.82 + 0.18 * highlight) * (1 - shade * 0.12))
    pb = int(paper[2] * (0.84 + 0.16 * highlight) * (1 - shade * 0.08))

    def in_eye(ex: float, rot: float) -> bool:
        dx, dy = nx - ex, ny + 0.04
        cr, sr = math.cos(rot), math.sin(rot)
        rx = dx * cr + dy * sr
        ry = -dx * sr + dy * cr
        return (rx / 0.16) ** 2 + (ry / 0.30) ** 2 <= 1.0

    if in_eye(-0.22, math.radians(-18)) or in_eye(0.22, math.radians(18)):
        pr, pg, pb = ink
    alpha = int(255 * edge)
    return bytes((max(0, min(255, pr)), max(0, min(255, pg)), max(0, min(255, pb)), alpha))


def write_ico(path: Path, sizes: list[int]) -> None:
    images = [(size, write_png(size, size, orb_pixel)) for size in sizes]
    count = len(images)
    offset = 6 + 16 * count
    directory = struct.pack("<HHH", 0, 1, count)
    payload = b""
    for size, png in images:
        directory += struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0,
            0,
            1,
            32,
            len(png),
            offset,
        )
        payload += png
        offset += len(png)
    path.write_bytes(directory + payload)


def write_icns(path: Path, entries: dict[bytes, bytes]) -> None:
    body = b""
    for ostype, data in entries.items():
        body += ostype + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    pngs = {}
    for size in (16, 32, 64, 128, 256, 512, 1024):
        pngs[size] = write_png(size, size, orb_pixel)
        if size in {32, 128, 256}:
            name = "128x128@2x.png" if size == 256 else f"{size}x{size}.png"
            (ROOT / name).write_bytes(pngs[size])
    write_ico(ROOT / "icon.ico", [16, 32, 48, 256])
    write_icns(
        ROOT / "icon.icns",
        {
            b"icp4": pngs[16],
            b"icp5": pngs[32],
            b"icp6": pngs[64],
            b"ic07": pngs[128],
            b"ic08": pngs[256],
            b"ic09": pngs[512],
            b"ic10": pngs[1024],
            b"ic11": pngs[32],
            b"ic12": pngs[64],
            b"ic13": pngs[256],
            b"ic14": pngs[512],
        },
    )
    print(f"wrote icons in {ROOT}")


if __name__ == "__main__":
    main()
