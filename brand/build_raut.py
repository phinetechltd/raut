"""
Derives every Raut brand asset from the two supplied source files.

Nothing here draws the mark — it only trims, squares, insets and rasterises the
artwork as given. The one judgement call is the adaptive-icon inset: Android's
circular mask crops a full-bleed foreground, which on the previous brand cut the
letterform in half, so the mark is keyed into the safe zone instead.
"""
from PIL import Image
import pathlib

SRC_MARK = pathlib.Path("../../ChatGPT Image Aug 18, 2026, 05_02_51 PM.png")
SRC_LOCKUP = pathlib.Path("../../WhatsApp Image 2026-08-09 at 5.56.58 PM.jpeg")
OUT = pathlib.Path(".")


def trimmed(img):
    """Crop to the artwork's own bounds, ignoring transparent margin."""
    return img.crop(img.getbbox())


def squared(img, pad_frac=0.10, bg=None):
    """Centre on a square canvas with breathing room."""
    w, h = img.size
    side = int(max(w, h) * (1 + pad_frac * 2))
    canvas = Image.new("RGBA", (side, side), bg or (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas


def main():
    mark = trimmed(Image.open(SRC_MARK).convert("RGBA"))
    mark.save(OUT / "raut-mark.png")
    print(f"raut-mark.png            {mark.size}")

    # App icon: the mark sits on white, the way the logo is presented. Its own
    # navy would disappear against a navy tile.
    icon = squared(mark, 0.12, bg=(255, 255, 255, 255)).resize((512, 512), Image.LANCZOS)
    icon.save(OUT / "raut-icon-512.png")
    print(f"raut-icon-512.png        {icon.size}")

    icon192 = icon.resize((192, 192), Image.LANCZOS)
    icon192.save(OUT / "raut-icon.png")
    print(f"raut-icon.png            {icon192.size}")

    # Adaptive foreground: 66% of the tile, transparent ground. Android crops a
    # 108dp canvas to a 72dp circle, so anything outside that keyhole is lost.
    fg = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    inner = mark.copy()
    inner.thumbnail((285, 285), Image.LANCZOS)
    fg.paste(inner, ((432 - inner.width) // 2, (432 - inner.height) // 2), inner)
    fg.save(OUT / "raut-adaptive-foreground.png")
    print(f"raut-adaptive-foreground {fg.size}  inner={inner.size}")

    lock = Image.open(SRC_LOCKUP).convert("RGB")
    lock.save(OUT / "raut-lockup.png")
    print(f"raut-lockup.png          {lock.size}")

    # Wordmark-only crop for headers: the lockup above the feature icons.
    w, h = lock.size
    wordmark = lock.crop((int(w * 0.10), 0, int(w * 0.90), int(h * 0.74)))
    wordmark.save(OUT / "raut-logo-tagline.png")
    print(f"raut-logo-tagline.png    {wordmark.size}")


if __name__ == "__main__":
    main()
