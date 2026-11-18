"""Generate crisp PNG icons for the Chrome extension and mobile PWA using stdlib only."""

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def write_png(path: str, width: int, height: int, pixels: bytearray) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0
        start = y * stride
        raw.extend(pixels[start : start + stride])

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def blend_pixel(buf: bytearray, idx: int, r: int, g: int, b: int, a: float) -> None:
    if a <= 0:
        return
    a = min(1.0, max(0.0, a))
    inv = 1.0 - a
    buf[idx] = int(buf[idx] * inv + r * a)
    buf[idx + 1] = int(buf[idx + 1] * inv + g * a)
    buf[idx + 2] = int(buf[idx + 2] * inv + b * a)
    buf[idx + 3] = min(255, int(buf[idx + 3] + (255 - buf[idx + 3]) * a))


def rounded_rect_sdf(px: float, py: float, cx: float, cy: float, hw: float, hh: float, r: float) -> float:
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    dx = max(qx, 0.0)
    dy = max(qy, 0.0)
    return math.hypot(dx, dy) + min(max(qx, qy), 0.0) - r


def dist_to_segment(px: float, py: float, x1: float, y1: float, x2: float, y2: float) -> float:
    vx = x2 - x1
    vy = y2 - y1
    wx = px - x1
    wy = py - y1
    len_sq = vx * vx + vy * vy
    t = 0.0 if len_sq == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / len_sq))
    dx = px - (x1 + t * vx)
    dy = py - (y1 + t * vy)
    return math.hypot(dx, dy)


def render_icon(size: int) -> bytearray:
    buf = bytearray(size * size * 4)
    s = float(size)
    aa = 1.2 / s  # anti-aliasing feather in normalized coords

    for y in range(size):
        ny = (y + 0.5) / s
        for x in range(size):
            nx = (x + 0.5) / s
            idx = (y * size + x) * 4

            # Rounded background card
            bg_d = rounded_rect_sdf(nx, ny, 0.5, 0.5, 0.46, 0.46, 0.22)
            bg_alpha = max(0.0, min(1.0, 0.5 - bg_d / aa))
            if bg_alpha > 0:
                t = max(0.0, min(1.0, (nx * 0.45 + ny * 0.55)))
                r = int(lerp(59, 99, t))    # Indigo-blue gradient (#3B82F6 -> #6366F1 -> #7C3AED)
                g = int(lerp(130, 82, t))
                b = int(lerp(246, 241, t))
                blend_pixel(buf, idx, r, g, b, bg_alpha)

            # Inner white flashcard stack back layer
            back_d = rounded_rect_sdf(nx, ny, 0.53, 0.45, 0.25, 0.20, 0.05)
            back_alpha = max(0.0, min(1.0, 0.5 - back_d / aa)) * 0.35
            if back_alpha > 0 and bg_alpha > 0:
                blend_pixel(buf, idx, 255, 255, 255, back_alpha)

            # Inner white flashcard front layer
            card_d = rounded_rect_sdf(nx, ny, 0.48, 0.52, 0.26, 0.21, 0.055)
            card_alpha = max(0.0, min(1.0, 0.5 - card_d / aa))
            if card_alpha > 0:
                blend_pixel(buf, idx, 255, 255, 255, card_alpha * 0.96)

            # Stylized "W" / checkmark wave stroke inside the card in deep indigo
            segs = [
                (0.32, 0.46, 0.39, 0.59),
                (0.39, 0.59, 0.48, 0.46),
                (0.48, 0.46, 0.57, 0.59),
                (0.57, 0.59, 0.64, 0.45),
            ]
            min_seg_d = min(dist_to_segment(nx, ny, *seg) for seg in segs)
            stroke_r = 0.036
            stroke_alpha = max(0.0, min(1.0, 0.5 - (min_seg_d - stroke_r) / aa))
            if stroke_alpha > 0:
                blend_pixel(buf, idx, 67, 56, 202, stroke_alpha)

            # Small golden star/sparkle accent at top-right of card
            spark_d = math.hypot(nx - 0.72, ny - 0.30) - 0.055
            spark_alpha = max(0.0, min(1.0, 0.5 - spark_d / aa))
            if spark_alpha > 0:
                blend_pixel(buf, idx, 251, 191, 36, spark_alpha)

    return buf


def main() -> None:
    ext_sizes = [16, 48, 128]
    for size in ext_sizes:
        pixels = render_icon(size)
        write_png(os.path.join(ROOT, "extension", "icons", f"icon{size}.png"), size, size, pixels)

    pwa_sizes = [192, 512]
    for size in pwa_sizes:
        pixels = render_icon(size)
        write_png(os.path.join(ROOT, "docs", "icons", f"icon-{size}.png"), size, size, pixels)

    print("Generated extension and PWA PNG icons successfully.")


if __name__ == "__main__":
    main()
