"""Trims a screenshot to the part of the screen the manual is talking about.

Cropping a real capture is fine; redrawing one is not. This only removes chrome
that the emulator put on top — a voice-input panel, in this case — and never
changes what the app rendered.
"""

import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent / "shots"

name, keep_top = sys.argv[1], float(sys.argv[2])
p = HERE / name
im = Image.open(p)
cut = int(im.height * keep_top)
im.crop((0, 0, im.width, cut)).save(p)
print(f"{name}  {im.width}x{im.height} -> {im.width}x{cut}")
