"""
Build Raut brand assets from the supplied logo artwork.

The logos are used as-is — cropped and resized, never redrawn.

Two masks are needed and they must not be confused:

  * OUTSIDE  — the white page around the rounded square. Found by flood-filling
    inward from the corners, because a plain "is it white?" test cannot tell the
    page background from the white S inside the logo.
  * GLYPH    — the X/O/S themselves, lifted off the navy by luminance.

Getting this wrong is what produced an earlier icon with opaque white corners.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SRC = Path(r"C:\Users\ondie\Downloads")
Raut = Path(r"C:\Users\ondie\Downloads\xos")
BRAND = Raut / "brand"
ANDROID_RES = Raut / "mobile" / "raut_field" / "android" / "app" / "src" / "main" / "res"
FLUTTER_ASSETS = Raut / "mobile" / "raut_field" / "assets" / "brand"
WEB_PUBLIC = Raut / "platform" / "public" / "brand"

FILES = {
    "icon":    "ChatGPT Image Aug 3, 2026, 02_29_05 PM.png",
    "tagline": "ChatGPT Image Aug 3, 2026, 02_23_52 PM.png",
    "light":   "ChatGPT Image Aug 3, 2026, 02_19_11 PM.png",
}

DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

SENTINEL = (255, 0, 255)


def luminance(p) -> float:
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def dark_square_bbox(img: Image.Image, max_lum: float = 110) -> tuple[int, int, int, int]:
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    left, top, right, bottom = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            if luminance(px[x, y]) < max_lum:
                if x < left: left = x
                if x > right: right = x
                if y < top: top = y
                if y > bottom: bottom = y
    return left, top, right, bottom


def square_crop(img: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    l, t, r, b = box
    cx, cy = (l + r) / 2, (t + b) / 2
    half = max(r - l, b - t) / 2
    return img.crop((round(cx - half), round(cy - half),
                     round(cx + half), round(cy + half)))


def outside_mask(icon: Image.Image, tol: int = 40) -> Image.Image:
    """
    L-mode mask: 255 where the pixel is page background outside the rounded
    square, 0 inside. Flood-filled from all four corners so the white S inside
    the logo is never reached.
    """
    work = icon.convert("RGB").copy()
    w, h = work.size
    for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if luminance(work.getpixel(corner)) > 200:
            ImageDraw.floodfill(work, corner, SENTINEL, thresh=tol)

    mask = Image.new("L", (w, h), 0)
    mp, wp = mask.load(), work.load()
    for y in range(h):
        for x in range(w):
            if wp[x, y] == SENTINEL:
                mp[x, y] = 255
    return mask


def with_transparent_surround(icon: Image.Image, outside: Image.Image) -> Image.Image:
    """The full logo, with only the page background knocked out."""
    rgba = icon.convert("RGBA")
    px, mp = rgba.load(), outside.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            if mp[x, y]:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    return rgba


def glyph_only(icon: Image.Image, outside: Image.Image,
               lo: float = 58, hi: float = 92) -> Image.Image:
    """Glyph lifted off the navy, page background also removed."""
    rgba = icon.convert("RGBA")
    px, mp = rgba.load(), outside.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if mp[x, y]:
                px[x, y] = (r, g, b, 0)
                continue
            lum = luminance((r, g, b))
            if lum <= lo:
                a = 0
            elif lum >= hi:
                a = 255
            else:
                a = round((lum - lo) / (hi - lo) * 255)
            px[x, y] = (r, g, b, a)
    return rgba


def main() -> None:
    for d in (BRAND, FLUTTER_ASSETS, WEB_PUBLIC):
        d.mkdir(parents=True, exist_ok=True)

    raw = Image.open(SRC / FILES["icon"])
    box = dark_square_bbox(raw)
    icon = square_crop(raw, box).convert("RGB").resize((1024, 1024), Image.LANCZOS)
    print(f"icon    square {box} -> {icon.size}")

    outside = outside_mask(icon)
    covered = sum(1 for p in outside.getdata() if p) / (1024 * 1024)
    print(f"        page background knocked out: {covered:.1%} of the frame")

    logo = with_transparent_surround(icon, outside)
    glyph = glyph_only(icon, outside)

    logo.save(BRAND / "raut-icon.png")
    logo.resize((512, 512), Image.LANCZOS).save(BRAND / "raut-icon-512.png")
    glyph.save(BRAND / "xos-glyph.png")

    raw_t = Image.open(SRC / FILES["tagline"])
    tag = square_crop(raw_t, dark_square_bbox(raw_t)).convert("RGB").resize(
        (1024, 1024), Image.LANCZOS)
    tag_logo = with_transparent_surround(tag, outside_mask(tag))
    tag_logo.save(BRAND / "raut-logo-tagline.png")
    print("tagline lockup written")

    Image.open(SRC / FILES["light"]).convert("RGBA").save(BRAND / "raut-wordmark-light.png")

    for folder, px in DENSITIES.items():
        target = ANDROID_RES / folder
        target.mkdir(parents=True, exist_ok=True)
        logo.resize((px, px), Image.LANCZOS).save(target / "ic_launcher.png")

        canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        inner_px = round(px * 0.68)
        inner = glyph.resize((inner_px, inner_px), Image.LANCZOS)
        off = (px - inner_px) // 2
        canvas.paste(inner, (off, off), inner)
        canvas.save(target / "ic_launcher_foreground.png")
        print(f"  {folder}: {px}px")

    logo.resize((512, 512), Image.LANCZOS).save(WEB_PUBLIC / "raut-icon.png")
    tag_logo.resize((512, 512), Image.LANCZOS).save(WEB_PUBLIC / "raut-logo-tagline.png")
    logo.resize((256, 256), Image.LANCZOS).save(Raut / "platform" / "src" / "app" / "icon.png")
    print("web assets written")

    logo.resize((512, 512), Image.LANCZOS).save(FLUTTER_ASSETS / "raut-icon.png")
    tag_logo.resize((512, 512), Image.LANCZOS).save(FLUTTER_ASSETS / "raut-logo-tagline.png")
    print("flutter assets written")


if __name__ == "__main__":
    main()
