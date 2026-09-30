"""Generate Rocktier Sign (SG) family icons from the design template.
Produces all platform icon sizes required by Tauri 2.
"""
from PIL import Image, ImageDraw, ImageFont
import os
import struct
import io

ICON_DIR = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
os.makedirs(ICON_DIR, exist_ok=True)

# Family design specs
BG = "#0A0A0A"
STROKE = "#333333"
TEXT_COLOR = "#FFFFFF"
RED = "#FF4A3D"

def make_icon(size):
    """Draw a single icon at the given size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Rounded rectangle background (19.5% corner radius)
    r = int(size * 0.195)
    margin = max(1, int(size * 0.03))
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=r,
        fill=BG,
        outline=STROKE,
        width=max(1, int(size * 0.015)),
    )
    
    # Badge (top-left circle with checkmark)
    badge_margin = int(size * 0.125)
    badge_size = int(size * 0.17)  # r of badge circle
    bx = badge_margin + badge_size
    by = badge_margin + badge_size
    bw = max(2, int(size * 0.024))
    draw.ellipse(
        [bx - badge_size, by - badge_size, bx + badge_size, by + badge_size],
        outline=TEXT_COLOR,
        width=bw,
    )
    # Checkmark
    cs = int(badge_size * 0.7)
    line_w = max(2, int(size * 0.028))
    draw.line([(bx - int(cs*0.4), by), (bx - int(cs*0.05), by + int(cs*0.4)),
               (bx + int(cs*0.45), by - int(cs*0.4))],
              fill=TEXT_COLOR, width=line_w)
    
    # Brand red dot (top-right)
    dot_r = int(size * 0.039)
    dot_cx = size - int(size * 0.16)
    dot_cy = int(size * 0.16)
    draw.ellipse(
        [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
        fill=RED,
    )
    
    text = "CO"
    font_size = int(size * 0.35)
    try:
        font = ImageFont.truetype("arial.ttf", font_size)
    except (IOError, OSError):
        try:
            font = ImageFont.truetype("segoeui.ttf", font_size)
        except (IOError, OSError):
            font = ImageFont.load_default()
    
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = int(size * 0.64) - bbox[1]
    draw.text((tx, ty), text, fill=TEXT_COLOR, font=font)
    
    return img


def save_png(img, name):
    path = os.path.join(ICON_DIR, name)
    img.save(path, "PNG")
    print(f"  {path}")


def make_ico(sizes):
    images = [make_icon(s) for s in sizes]
    ico = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + len(images) * 16
    data = b''
    for img in images:
        img = img.convert('RGBA')
        w, h = img.size
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        png_data = buf.getvalue()
        ico += struct.pack('<BBBBHHII',
            w if w < 256 else 0, h if h < 256 else 0,
            0, 0, 1, 32, len(png_data), offset)
        offset += len(png_data)
        data += png_data
    path = os.path.join(ICON_DIR, "icon.ico")
    with open(path, 'wb') as f:
        f.write(ico + data)
    print(f"  {path}")


print("Generating icons...")
for s in [16, 32, 64, 128, 256, 512, 1024]:
    save_png(make_icon(s), f"{s}x{s}.png")
save_png(make_icon(256), "128x128@2x.png")
make_ico([16, 32, 48, 64, 128, 256])
print("Done!")
