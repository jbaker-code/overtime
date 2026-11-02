# Overtime ⏱

**Overtime** is a tiny always-on-top desktop widget that shows the current time *and* a stopwatch for how long you've been recording. It floats over whatever you're capturing so you — and your viewers — can watch the minutes burn, because the "10-minute" screencast always runs long. Frameless, transparent, stays on top, and gets out of the way until you need it.

![Overtime — an always-on-top clock + recording stopwatch, shown in several looks](assets/overtime-demo.gif)

> Built on camera with Claude Code for the [BakerCode](https://www.youtube.com/@bakercode) YouTube series, then set loose as its own little app.

---

## Install

### Just want to use it? (most people)

Grab the binary — no installer, nothing to set up. Either download this repo (green **Code → Download ZIP** button on GitHub) or just download the one zip you need from the [`releases/`](releases/) folder:

| Your machine | Download |
|---|---|
| **macOS — Apple Silicon** (M1/M2/M3…) | [`releases/Overtime-mac-arm64-v1.0.0.zip`](releases/Overtime-mac-arm64-v1.0.0.zip) |
| **macOS — Intel** | [`releases/Overtime-mac-x64-v1.0.0.zip`](releases/Overtime-mac-x64-v1.0.0.zip) |
| **Windows** (x64) | [`releases/Overtime-windows-x64-v1.0.0.zip`](releases/Overtime-windows-x64-v1.0.0.zip) |

Then:

- **macOS** — unzip, drop `Overtime.app` wherever you like, double-click. It's **unsigned**, so the first time: right-click → **Open** (or System Settings → Privacy & Security → **Open Anyway**).
- **Windows** — unzip the folder fully, run `Overtime.exe`. SmartScreen may warn about an unknown publisher: **More info → Run anyway**.

Overtime lives in your **menu bar / system tray** (no Dock or taskbar clutter) — click it for Play/Pause/Reset, show/hide each readout, settings, and quit. Full walkthrough in **[docs/GUIDE.md](docs/GUIDE.md)**.

> Want the quick-look version? [`releases/overtime-single-file.html`](releases/overtime-single-file.html) is the whole thing in one file — open it in any browser (clock + stopwatch work; always-on-top and transparency are desktop-only). The full source is [`releases/overtime-source-v1.0.0.zip`](releases/overtime-source-v1.0.0.zip).

### Want to build or hack on it? (developers)

```bash
git clone https://github.com/jbaker-code/overtime.git
cd overtime
npm install
npm start          # run the widget locally (Electron)
```

Build commands (outputs land in a dated `tmp/overtime-build-…/dist/` folder):

| Command | What it builds |
|---|---|
| `npm run build` | **everything** — macOS (arm64 + x64), Windows, single-file HTML, and a source zip |
| `npm run build:mac` | macOS `.app` zips (unsigned, `dir` target — no installer) |
| `npm run build:win` | Windows app folder, zipped (cross-built from macOS, no installer) |
| `npm run build:single` | the self-contained single-file `index.html` |
| `npm run build:source` | a source zip |
| `npm test` | the Playwright suite (unit + single-file in headless Chromium + the real Electron app) |
| `npm run clean` | wipe the build temp + scratch |

Architecture, the build pipeline, and how it's all wired live in **[docs/GUIDE.md](docs/GUIDE.md)** and **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## What it does

- **Wall clock** (`HH:MM` + AM/PM, or 24-hour) and an **episode stopwatch** (`HH:MM:SS`) with Play / Pause / Reset.
- **Always-on-top, frameless, transparent** — a rounded pill that floats over your recording and is captured fine by OBS.
- **Hover for controls**, drag anywhere to move, resize freely — the readouts scale to fill whatever size you pick.
- **Make it yours**: 10 layouts × 10 fonts × 10 background/text colors, an opacity slider, and tray toggles to show/hide either readout (turn both off for a blank pill). It remembers everything between launches.

---

## Credits & license

- **Author:** Claude (Anthropic) — written on camera with [Claude Code](https://claude.com/claude-code).
- **Ideas guy / direction:** Jason Baker · <jason@bakercode.org> · [BakerCode](https://www.youtube.com/@bakercode)
- **License:** [MIT](LICENSE) — do what you like, just keep the notice.
- **Home:** https://github.com/jbaker-code/overtime
