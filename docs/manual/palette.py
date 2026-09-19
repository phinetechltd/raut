"""Reads the brand palette out of the supplied logo.

Counting raw pixels just returns the largest block of ink — the navy wordmark —
and misses the accents entirely. Clustering by hue instead surfaces each
distinct colour in the artwork, which is what a palette actually is.
"""

import colorsys
from collections import defaultdict

from PIL import Image


def clusters(path: str):
    im = Image.open(path).convert("RGBA")
    buckets = defaultdict(lambda: [0, 0, 0, 0])  # r, g, b, n

    for r, g, b, a in im.getdata():
        if a < 200:
            continue
        h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        # Greys carry no hue, and near-white is the page behind the mark.
        if s < 0.15 or l > 0.94:
            continue
        key = (round(h * 24), round(l * 5))  # 24 hue bands, 5 lightness bands
        acc = buckets[key]
        acc[0] += r
        acc[1] += g
        acc[2] += b
        acc[3] += 1

    total = sum(v[3] for v in buckets.values()) or 1
    out = []
    for (hb, lb), (r, g, b, n) in buckets.items():
        if n / total < 0.004:
            continue
        out.append((n, (r // n, g // n, b // n)))
    return sorted(out, reverse=True), total


for path in ["brand/raut-logo-tagline.png", "brand/raut-mark.png"]:
    found, total = clusters(path)
    print(f"{path}  coloured px={total}")
    for n, (r, g, b) in found:
        h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        print(f"   #{r:02X}{g:02X}{b:02X}  {n/total:6.1%}  hue={h*360:5.0f}  light={l:.2f}")
    print()
