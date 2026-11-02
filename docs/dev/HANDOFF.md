# Developer notes

> This file started life as a session-recovery handoff (agent IDs, "read me after a
> compaction", a catch-up checklist) from when Overtime was built on camera. All of that
> was ephemeral, so it's been trimmed down to the bits with lasting value: a map of the
> other dev docs, and a couple of build-environment gotchas worth knowing.

## Where things live

- **[`../GUIDE.md`](../GUIDE.md)** — the detailed user + build + test guide (start here).
- **[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)** — how the app is wired: process
  model, IPC contract, stopwatch state machine, config schema, build pipeline.
- **[`PRD.md`](./PRD.md)** — the original product spec (historical).
- **[`PLAN.md`](./PLAN.md)** — the original implementation plan (historical, superseded in
  parts).
- **[`DECISIONS.md`](./DECISIONS.md)** — decisions and open questions from the build.
- **[`HISTORY.md`](./HISTORY.md)** — the informal "what changed" log.

## Build-environment gotchas

- **The Electron half can only be fully verified on real macOS.** The unit and single-file
  Playwright projects run anywhere Chromium does; the `electron` project needs an Electron
  binary and skips itself cleanly when `EPISODE_TIMER_SKIP_ELECTRON=1` or none is found.
  Point it at a specific binary with `EPISODE_TIMER_ELECTRON_PATH` if the npm dependency's
  copy isn't usable.
- **`.app` bundles and the Electron binary contain symlinks**, which some network/shared
  filesystems can't store. That's why electron-builder's scratch stays on local disk in the
  OS temp dir (`overtime-build-scratch`, override with `EPISODE_TIMER_SCRATCH`) and only the
  finished, symlink-free zips are copied into the build output folder.
- **A few internal identifiers still use the old `EPISODE_TIMER_` / `episodeTimer` prefix**
  from when the app was called *Episode Timer*. They're intentional leftovers — see the
  naming notes in `GUIDE.md` and `ARCHITECTURE.md`.
