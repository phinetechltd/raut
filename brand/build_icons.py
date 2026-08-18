"""
Rasterises the Raut launcher icons from the supplied artwork.

Two families, because Android needs both:

  ic_launcher            legacy square bitmap, mark on white
  ic_launcher_foreground adaptive foreground on a transparent 108dp canvas,
                         inset into the safe zone

The inset is the whole point. A full-bleed foreground gets cropped by the
launcher's circular mask, which on the previous brand sliced the letterform in
half on a Pixel. Here the mark occupies ~66% of the canvas so every mask shape
clears it.
"""
from PIL import Image
import pathlib

RES = pathlib.Path("mobile/raut_field/android/app/src/main/res")
ICON = Image.open("brand/raut-icon-512.png").convert("RGBA")   # mark on white
MARK = Image.open("brand/raut-mark.png").convert("RGBA")        # transparent

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def main():
    for bucket, px in LEGACY.items():
        out = RES / f"mipmap-{bucket}" / "ic_launcher.png"
        ICON.resize((px, px), Image.LANCZOS).save(out)
        print(f"  {out}  {px}x{px}")

    for bucket, px in ADAPTIVE.items():
        canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        inner = MARK.copy()
        safe = int(px * 0.66)
        inner.thumbnail((safe, safe), Image.LANCZOS)
        canvas.paste(inner, ((px - inner.width) // 2, (px - inner.height) // 2), inner)
        out = RES / f"mipmap-{bucket}" / "ic_launcher_foreground.png"
        canvas.save(out)
        print(f"  {out}  {px}x{px} inner={inner.size}")


if __name__ == "__main__":
    main()
