# Raut brand assets

**The supplied artwork is the source of truth. Do not redraw the mark.**

An earlier pass reproduced the logo in SVG and in a Flutter `CustomPainter`.
Both drifted from the real thing — one of them lost the S entirely. Everything
here is derived from the original files by cropping and resizing only.

## Source files

The three originals live in `~/Downloads`:

| File | Used for |
| --- | --- |
| `ChatGPT Image Aug 3, 2026, 02_29_05 PM.png` | The icon — everything below derives from this |
| `ChatGPT Image Aug 3, 2026, 02_23_52 PM.png` | The lockup with the "Building trust in operations" strapline |
| `ChatGPT Image Aug 3, 2026, 02_19_11 PM.png` | Light/transparent wordmark, for pale backgrounds |

## Generated assets

| File | Where it is used |
| --- | --- |
| `raut-icon.png` (1024) | Console sidebar, Flutter `RautMark`, Android launcher |
| `raut-icon-512.png` | Convenience size |
| `raut-logo-tagline.png` | Console login hero, Flutter `RautLockup` |
| `raut-wordmark-light.png` | Reserved for light backgrounds |
| `raut-wordmark-alpha.png` | Wordmark keyed onto transparency — the adaptive-icon foreground |

Copies are placed in `platform/public/brand/`, `platform/src/app/icon.png` and
`mobile/raut_field/assets/brand/`.

## Rebuilding

```bash
python brand/build_brand.py   # crop the originals, distribute to web + flutter
python brand/build_icons.py   # Android launcher + adaptive icons
```

## Why the Android icon is built the way it is

Three approaches were tried before the current one; the notes are in the
scripts, but in short:

1. **Full-bleed logo as the adaptive foreground.** The Pixel launcher's
   circular mask clipped the S. Verified on device — the icon read "XO".
2. **Logo inset over a flat navy fill.** The artwork's navy is a diagonal
   gradient, so the inset square's edge stayed visible as a ghost outline.
3. **Logo inset over a stretched edge-column backdrop.** Banded, for the same
   reason.

What works: **background** is a vertical gradient sampled between the artwork's
own top and bottom navy; **foreground** is the wordmark alone, lifted off the
navy and inset to 62% so it survives a circular mask.

The lift keys on the **blue channel**, not luminance. Luminance was the earlier
mistake — the navy peaks at 46 and the X's deepest blue bottoms at 32, so they
overlap and any threshold either eats the X or leaves navy fringing. Blue
separates them cleanly: navy never exceeds B=105, the X's body sits at B=191+.

A morphological open (erode ×2, dilate ×2) then clears the scatter of stray
pixels the artwork's gradient noise pushes over the threshold. Without it the
bounding box blows out to the full frame and the icon speckles.

Legacy launchers get the untouched artwork — they do not mask, so nothing needs
adjusting for them.
