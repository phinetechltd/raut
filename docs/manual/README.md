# Field Sales handbook

`Raut-Field-Sales-Handbook.pdf` — the guide reps get with the POS device.

Everything in it is generated. Nothing is hand-placed, so a UI change means
re-capturing rather than re-drawing.

## Rebuilding

```bash
python docs/manual/build_manual.py     # writes the PDF
python docs/manual/preview.py          # renders each page to preview/ to check
```

`preview.py` matters more than it looks. A PDF that builds without error can
still have a screenshot overrunning the footer or text sitting off the page —
rendering is the only way to know, and two layout bugs were found exactly that
way.

## Screenshots

`shots/` holds real captures from the app running against a dev server. They are
never mocked up: a manual whose screens do not match the device is one the reader
stops trusting on page two.

To re-capture, with an emulator running and the app installed:

```powershell
docs/manual/capture-return.ps1      # the return flow, end to end
docs/manual/capture-features.ps1    # route, customers, ordering, payments
docs/manual/shot.ps1 -Name my-shot  # one screen
```

Things worth knowing before you run them:

- **Build with the API base or you will capture production.** `AppConfig.apiBase`
  defaults to `https://raut.co.ke`, deliberately. A capture build needs
  `--dart-define=RAUT_API_BASE=http://10.0.2.2:3200`, and the login screen shows
  a **NOT PRODUCTION** badge when it is set. If that badge is missing, stop.
- `shot.ps1` captures to a file **on the device** and pulls it. PowerShell's `>`
  redirect writes a BOM and re-encodes, which corrupts every PNG it touches.
  From Git Bash, `adb pull /sdcard/...` needs `MSYS_NO_PATHCONV=1` or the path is
  rewritten to `C:/Program Files/Git/sdcard/...`.
- The scripts press **Enter** to submit the sign-in form rather than tapping the
  button: the keyboard covers it, and `BACK` closes the app rather than the
  keyboard on that screen.
- **Tap coordinates shift when the offline banner is showing** — it adds about
  195px at the top. The scripts assume it is absent.
- Set the device's position before capturing anything that shows a distance:
  `adb -s emulator-5554 emu geo fix <lng> <lat>`. The emulator otherwise sits in
  Mountain View, and the geofence dialog reads "15459409m away". Repositioning
  the device is fair; editing the screenshot is not.
- Next's dev server compiles routes on first request. A cold `/auth/login` can
  exceed the app's timeout and shows "server took too long" — warm it with a
  `curl` first rather than assuming the emulator cannot reach the host.

The emulator needs headroom — a debug APK is ~160MB and will not install on a
nearly-full image. Build with `--release --target-platform android-x64` (~20MB)
for capture runs. Use `adb install -r` to keep the local database; uninstalling
destroys any queued work you were hoping to photograph.

## Brand

`palette.py` reads the colours out of `brand/raut-logo-tagline.png` by clustering
on hue, so the document and the artwork cannot drift:

| | |
|---|---|
| `#032646` | navy — headers, headings |
| `#03ADE0` | cyan — rules, callouts |
| `#06B4B8` | teal — secondary callouts |
| `#45CC13` | green — success states |

Counting raw pixels only finds the navy wordmark and misses the accents
entirely, which is why the clustering is there.

**The logo is never recoloured.** Its wordmark is navy, drawn for light
backgrounds; on the dark cover it sits on a white panel rather than being
lightened to suit.
