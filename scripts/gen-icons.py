#!/usr/bin/env python3
"""Generate all platform icons for Rocktier Compressor (family standard)."""

import os
import struct
import zlib
from pathlib import Path

# --- Config ---
ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="192" fill="#0A0A0A"/>
  <text x="512" y="640" font-family="Inter, -apple-system, sans-serif"
        font-size="360" font-weight="700" letter-spacing="-20"
        text-anchor="middle" fill="#FFFFFF">CO</text>
  <circle cx="800" cy="224" r="48" fill="#FF4A3D"/>
</svg>"""

# Minimal PNG encoder (no Pillow dependency)
def create_png(size, text="CO"):
    """Create a minimal solid-color PNG with the brand color."""
    width = height = size
    
    # Simple solid black rounded-rect approximation
    raw_data = b""
    for y in range(height):
        raw_data += b"\x00"  # filter byte
        for x in range(width):
            # Rounded corners check
            r = int(size * 0.19)
            cx, cy = x, y
            in_corner = (
                (cx < r and cy < r and ((cx - r)**2 + (cy - r)**2) > r**2) or
                (cx >= size - r and cy < r and ((cx - (size - r))**2 + (cy - r)**2) > r**2) or
                (cx < r and cy >= size - r and ((cx - r)**2 + (cy - (size - r))**2) > r**2) or
                (cx >= size - r and cy >= size - r and ((cx - (size - r))**2 + (cy - (size - r))**2) > r**2)
            )
            if in_corner:
                raw_data += b"\x00\x00\x00\x00"  # transparent
            else:
                # Red brand dot area (top-right)
                dot_cx, dot_cy = int(size * 0.78), int(size * 0.22)
                dot_r = int(size * 0.05)
                in_dot = (x - dot_cx)**2 + (y - dot_cy)**2 <= dot_r**2
                if in_dot:
                    raw_data += b"\xff\x4a\x3d\xff"  # brand red
                else:
                    raw_data += b"\x0a\x0a\x0a\xff"  # dark bg
    
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack(">I", zlib.crc32(c) & 0xffffffff)
        return struct.pack(">I", len(data)) + c + crc
    
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    compressed = zlib.compress(raw_data, 9)
    idat = b"IDAT" + compressed
    iend = b"IEND"
    
    return sig + chunk(b"IHDR", ihdr) + chunk(idat, idat[4:]) + chunk(iend, b"")


def main():
    project_root = Path(__file__).parent.parent
    icons_dir = project_root / "src-tauri" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)

    sizes = [16, 32, 64, 128, 256, 512, 1024]
    
    print("Generating icons...")
    for size in sizes:
        png_data = create_png(size)
        out_path = icons_dir / f"{size}x{size}.png"
        out_path.write_bytes(png_data)
        print(f"  {out_path}")

    # @2x variants for macOS
    for size in [128, 256, 512]:
        png_data = create_png(size * 2)
        out_path = icons_dir / f"{size}x{size}@2x.png"
        out_path.write_bytes(png_data)
        print(f"  {out_path}")

    # Write SVG source
    svg_path = project_root / "icon.svg"
    svg_path.write_text(ICON_SVG)
    print(f"  {svg_path}")

    print("Done! (ICO generation requires Pillow - run Pillow variant if needed)")


if __name__ == "__main__":
    main()
