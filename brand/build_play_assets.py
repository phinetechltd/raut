"""
Builds the Google Play store-listing assets to Play's exact specifications.

Play is strict about geometry, and a listing is rejected for being a few pixels
out, so every dimension here is fixed rather than derived:

  app icon         512 x 512    PNG, <= 1 MB
  feature graphic  1024 x 500   PNG, <= 15 MB
  phone screenshot 1080 x 1920  PNG, <= 8 MB each, exactly 9:16

The raw device captures are 1080 x 2424 (ratio 0.4455), which is *not* 9:16
(0.5625) — a modern tall phone is narrower than Play's frame. They are therefore
composed onto a 1080 x 1920 canvas rather than cropped, so no UI is cut off, and
the surrounding space carries a caption. 1080 on the short side is also the
threshold Play sets for promotion eligibility.

    python brand/build_play_assets.py
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import pathlib

OUT = pathlib.Path("../../raut-play-assets")  # Downloads/raut-play-assets
SHOTS = pathlib.Path("../mobile/raut_field/screenshots")
BRAND = pathlib.Path(".")

# Sampled from the logo — see platform/src/lib/design-tokens.ts
NAVY = (5, 39, 68)
NAVY_DEEP = (3, 26, 46)
CYAN = (10, 182, 214)
GREEN = (67, 204, 24)
WHITE = (255, 255, 255)

F_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"
F_SEMI = r"C:\Windows\Fonts\seguisb.ttf"
F_REG = r"C:\Windows\Fonts\segoeui.ttf"

# One caption per screen. Written for someone scrolling a store listing, so each
# names a benefit rather than a feature.
CAPTIONS = [
    ("03-route.png", "Today's route,", "already in the right order"),
    ("07-visit.png", "Check in, sell", "and collect on one screen"),
    ("04-customers.png", "Every customer", "in your pocket, offline"),
    ("05-today.png", "Your day,", "counted honestly"),
    ("06-more.png", "Nothing waiting,", "nothing lost"),
    ("01-login.png", "Built for reps", "who work off-grid"),
]


def font(path, size):
    return ImageFont.truetype(path, size)


def vertical_gradient(size, top, bottom):
    """A single-column gradient stretched to width — cheap and smooth."""
    w, h = size
    col = Image.new("RGB", (1, h))
    px = col.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return col.resize(size, Image.BILINEAR)


def rounded(img, radius):
    """Round an image's corners, keeping alpha."""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1],
                                           radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def drop_shadow(img, blur=26, offset=12, opacity=110):
    """Soft shadow behind a rounded image, on its own transparent layer."""
    pad = blur * 3
    layer = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    shade = Image.new("RGBA", img.size, (0, 0, 0, opacity))
    shade.putalpha(Image.eval(img.split()[3], lambda a: int(a * opacity / 255)))
    layer.paste(shade, (pad, pad + offset), shade)
    return layer.filter(ImageFilter.GaussianBlur(blur)), pad


def app_icon():
    """512x512 exactly, flattened — Play shows icons on varied backgrounds."""
    src = Image.open(BRAND / "raut-icon-512.png").convert("RGBA")
    canvas = Image.new("RGB", (512, 512), WHITE)
    canvas.paste(src, (0, 0), src)
    p = OUT / "icon" / "app-icon-512.png"
    canvas.save(p, optimize=True)
    return p, canvas.size


def feature_graphic():
    """
    1024x500. Play crops and overlays this in places, so the mark and wordmark
    sit left of centre and nothing important goes near the edges.
    """
    W, H = 1024, 500
    canvas = vertical_gradient((W, H), NAVY, NAVY_DEEP).convert("RGBA")

    # A soft cyan bloom, echoing the logo's arm.
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([620, -160, 1180, 400], fill=CYAN + (60,))
    canvas = Image.alpha_composite(canvas, glow.filter(ImageFilter.GaussianBlur(90)))

    mark = Image.open(BRAND / "raut-mark.png").convert("RGBA")
    mark.thumbnail((300, 300), Image.LANCZOS)
    mx, my = 655, (H - mark.height) // 2

    # The mark sits on a light disc. Its road and lower leg are the same navy as
    # this background — measured at 1.12 contrast, which is invisible — and
    # recolouring supplied brand artwork to suit a backdrop is how a logo turns
    # into a lookalike. Giving it a light ground instead keeps it exact.
    cx, cy = mx + mark.width // 2, my + mark.height // 2
    # Sized to sit wholly inside the canvas: Play overlays its own UI on
    # this graphic in places, so nothing should touch an edge.
    r = 196
    disc = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(disc).ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE + (255,))
    canvas = Image.alpha_composite(canvas, disc.filter(ImageFilter.GaussianBlur(6)))

    canvas.paste(mark, (mx, my), mark)

    d = ImageDraw.Draw(canvas)
    d.text((72, 150), "RAUT", font=font(F_BOLD, 96), fill=WHITE)
    d.text((78, 262), "ONE PLATFORM.  EVERY MILE.",
           font=font(F_SEMI, 27), fill=(150, 205, 235))
    d.text((78, 320), "Field sales, van sales and fleet —",
           font=font(F_REG, 25), fill=(196, 214, 232))
    d.text((78, 356), "built to work with no signal.",
           font=font(F_REG, 25), fill=(196, 214, 232))
    d.line([(78, 246), (150, 246)], fill=GREEN, width=4)

    p = OUT / "feature" / "feature-graphic-1024x500.png"
    canvas.convert("RGB").save(p, optimize=True)
    return p, (W, H)


def phone_screenshot(src_name, line1, line2, index):
    """
    1080x1920 exactly (9:16). The 1080x2424 capture is scaled to fit, never
    cropped, so no part of the UI is lost.
    """
    W, H = 1080, 1920
    canvas = vertical_gradient((W, H), NAVY, NAVY_DEEP).convert("RGBA")

    d = ImageDraw.Draw(canvas)
    d.text((72, 118), line1, font=font(F_BOLD, 62), fill=WHITE)
    d.text((72, 196), line2, font=font(F_SEMI, 44), fill=(150, 205, 235))
    d.line([(74, 292), (152, 292)], fill=GREEN, width=5)

    shot = Image.open(SHOTS / src_name).convert("RGBA")
    target_h = 1470
    shot = shot.resize(
        (round(shot.width * target_h / shot.height), target_h), Image.LANCZOS
    )
    shot = rounded(shot, 26)

    shadow, pad = drop_shadow(shot)
    x = (W - shot.width) // 2
    y = 372
    canvas.alpha_composite(shadow, (x - pad, y - pad))
    canvas.alpha_composite(shot, (x, y))

    p = OUT / "phone" / f"{index:02d}-{src_name.split('-', 1)[1]}"
    canvas.convert("RGB").save(p, optimize=True)
    return p, (W, H)


def main():
    for sub in ("icon", "feature", "phone"):
        (OUT / sub).mkdir(parents=True, exist_ok=True)

    print("app icon        ", *app_icon())
    print("feature graphic ", *feature_graphic())
    for i, (name, l1, l2) in enumerate(CAPTIONS, start=1):
        print(f"phone {i}         ", *phone_screenshot(name, l1, l2, i))


if __name__ == "__main__":
    main()
