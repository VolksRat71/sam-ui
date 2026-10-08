<!-- sam-ui (Apache-2.0). New file; Meta's original README is docs/SAM2_UPSTREAM.md. -->
# sam-ui

Rotoscoping and masking for video, on [SAM 2](https://github.com/facebookresearch/sam2)
and SAM 3. It is for compositors, motion designers and anyone who needs mattes of
objects in real footage. Click an object or describe it, track it through the clip,
correct and review the result, then export mattes, outlines or a roto folder. Footage
opened from After Effects goes back as a new comp with the masks on it.

It comes as a **macOS app** that runs the full models on your Mac, and a **browser
demo** that runs a small model with no install. Every object keeps its own cached
track, so Track only re-runs the objects that are new or changed, and everything else
stays as it was, including after a reload or a restart.

https://github.com/user-attachments/assets/fbd8f37d-21ea-4036-98c0-7fe0a4ddefe1

sam-ui began as a fork of Meta's SAM 2 web demo. The backend keeps Meta's model code
and adds a track cache, a second engine (SAM 3), exports and a job system. The
frontend, **studio**, replaces the demo UI with a compositing-style workspace.

## Download

**macOS 14 or newer, Apple Silicon (M1 or later):** get `sam-ui-<version>-arm64.dmg` from the
[latest release](https://github.com/VolksRat71/sam-ui/releases/latest) and drag it
into Applications.
- On first launch it downloads SAM 2.1 large (about 900 MB, hash-checked). The app
  runs the full model locally on your GPU, with no other install.
- The build is **not signed yet**: the first time, right-click the app and choose
  **Open** (macOS 14), or open it once and click **Open Anyway** in System Settings >
  Privacy & Security (macOS 15 and later), or run
  `xattr -dr com.apple.quarantine /Applications/sam-ui.app`.
- **SAM 3 (optional):** accept Meta's SAM License on
  [facebook/sam3](https://huggingface.co/facebook/sam3), then choose
  **SAM 3 > Download SAM 3 with a Hugging Face token…**. See
  [`desktop/README.md`](desktop/README.md).
- **After Effects (optional):** the round trip needs
  [AE MCP Vision v2.2.0](https://github.com/VolksRat71/after-effects-mcp-vision/releases/tag/v2.2.0)
  installed in After Effects, with its panel open.
- The app checks GitHub for a newer release at most once a day and shows a banner
  with a link; **Help > Check for Updates…** checks now. It never downloads or
  installs anything itself.

**Or try it in the browser:** [volksrat71.github.io/sam-ui](https://volksrat71.github.io/sam-ui/)
runs SAM 2.1 tiny on WebGPU with no install, no server and nothing uploaded (your
video stays in the browser). Chrome or Edge on desktop. Firefox does not work yet
([#4](https://github.com/VolksRat71/sam-ui/issues/4)). Safari itself is untested, though its
engine tracks correctly in Playwright's WebKit build
([#3](https://github.com/VolksRat71/sam-ui/issues/3)). It is a demo: clips up to 5 minutes,
and the app's SAM 2.1 large and SAM 3 give much better masks. Or [run it from source](docs/development.md#run-from-source).

## Features

Each links to its section in [Features](docs/features.md); how studio works control by
control is in [Using studio](docs/using-studio.md).

- **[Track](docs/features.md#track):** click an object or describe it (SAM 3), and track
  it with SAM 2.1 large, SAM 3 or SAM 2.1 tiny in the browser.
- **[Correct](docs/features.md#correct):** fix any frame, re-track only around the fix
  (SAM 2), mark where an object is absent, undo, and go back to kept versions.
- **[Review](docs/features.md#review):** a short, ranked list of stops worth a look on
  each track.
- **[Organise](docs/features.md#organise):** named objects in coloured groups, a lane per
  object, and layouts for phones and tablets.
- **[Export and After Effects](docs/features.md#export-and-after-effects):** mask videos,
  Vector JSON, a roto folder with PNG mattes, an MP4 with effects, or an AE comp.
- **[Experimental](docs/features.md#experimental):** Refine Detail, for small details on
  one frame, off by default.

## Works with After Effects

In the desktop app, **Media > Open from After Effects** opens footage from the open AE
project where it is, with no upload and no re-encode, so frame N in sam-ui is frame N in
AE. **Export > Export to After Effects** makes a new comp with one layer per object and
its outlines as mask-path keys. It needs
[AE MCP Vision](https://github.com/VolksRat71/after-effects-mcp-vision) v2.2.0 installed
in After Effects. Details and limits are in
[Export and After Effects](docs/features.md#export-and-after-effects).

## Hardware

Memory does not grow with clip length, so the model sets the hardware floor, not the
clip. The app needs an Apple Silicon Mac (M1 or later) on macOS 14 or newer; 16 GB is
recommended. Measured figures, estimated minimums, benchmarks and platform support are in
[Hardware](docs/hardware.md).

## Documentation

- [Features](docs/features.md): everything sam-ui does, area by area.
- [Using studio](docs/using-studio.md): the UI control by control, the browser engine,
  phones and tablets, and how studio compares with Meta's demo.
- [Hardware](docs/hardware.md): memory, speed, benchmarks and platform support.
- [Development](docs/development.md): run from source, settings, architecture, API, tests.
- [`studio/README.md`](studio/README.md): the web UI package and the browser-only build.
- [`desktop/README.md`](desktop/README.md): the macOS app: install, develop and build.
- [`docs/SAM2_UPSTREAM.md`](docs/SAM2_UPSTREAM.md): Meta's original SAM 2 README.

## Licences and credits

- sam-ui is **Apache-2.0**, like SAM 2. It is a modified version of
  [SAM 2](https://github.com/facebookresearch/sam2) by Meta Platforms, Inc.
  [`NOTICE-sam-ui.md`](NOTICE-sam-ui.md) lists what changed. Files we modified carry
  a notice, and Meta's copyright headers are kept.
- **SAM 3 is not included.** Its code and weights are under Meta's
  [SAM License](https://huggingface.co/facebook/sam3), not Apache. sam-ui imports
  Hugging Face `transformers` at run time and loads weights you download yourself.
- The After Effects round trip goes through
  [AE MCP Vision](https://github.com/VolksRat71/after-effects-mcp-vision), a separate
  project you install yourself. sam-ui does not include it.
- The Inter font is under the SIL Open Font License; the licence ships with it in
  `studio/public/fonts/`.
- Meta's original README, with the model details, checkpoints and training, is
  [`docs/SAM2_UPSTREAM.md`](docs/SAM2_UPSTREAM.md).
