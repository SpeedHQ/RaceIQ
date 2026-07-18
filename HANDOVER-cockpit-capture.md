# Handover — RaceIQ cockpit/UI capture pipeline

## Goal
Building a RaceIQ product showcase video. Current sub-task: capture deterministic
animated-UI clips (cockpit + analyse views) via Playwright frame-stepping, then
recut into the teaser.

- Working dir: `C:\Users\acoop\Documents\GitHub\RaceIQ`
- Showcase repo (separate): `C:\Users\acoop\Documents\GitHub\raceiq-showcase`
- Platform: Windows 11, PowerShell primary + Bash tool. Runtime: **bun** (v1.3.14).
- App served at `http://raceiq.localhost:1355` (Vite dev server). Backend server
  also runs (`bun run server/index.ts`).

## Task list (live)
- #11 [done] Map deterministic frame-step hooks in app
- #12 [done] Build deterministic animated-UI capture (Playwright frame-step)
- #13 [in_progress] Isometric shining UI entry
- #14 [pending] Recut teaser with animated UI clips

## Capture scripts
- `playwright/record-cockpit.mjs` — captures cockpit/analyse views.
  - Launch: `chromium.launch({ headless: true, timeout: 60_000 })` (plain, no GPU
    args — comment notes GPU args conflict with chrome-headless-shell on Win and
    hang launch).
  - Args: URL, then positional (scale, frames, ..., view-schedule like
    `"0:REAR,0.5:3/4"`). Example invocation that was being run:
    ```
    cd "C:/Users/acoop/Documents/GitHub/RaceIQ" && \
    COCKPIT_FRAMES_DIR="/c/Users/acoop/AppData/Local/Temp/raceiq-cockpit-frames" \
    bun playwright/record-cockpit.mjs \
    "http://raceiq.localhost:1355/ac-evo/analyse?track=13&car=68&lap=42" \
    0.30 400 1 0.01 "0:REAR,0.5:3/4" 2
    ```
  - User's last request (interrupted, NOT yet done): **start the analyse clip ~2s
    earlier in the lap.** Need to adjust the lap/start param accordingly.

## BLOCKER — Playwright launch hangs (current)
`chromium.launch()` times out (60s / 30s) — process spawns (pid appears) but the
`--remote-debugging-pipe` DevTools handshake never completes.

### What was ruled out
- **Binary is fine.** `chrome-headless-shell.exe` at
  `C:\Users\acoop\AppData\Local\ms-playwright\chromium_headless_shell-1228\chrome-headless-shell-win64\chrome-headless-shell.exe`
  - `--version` → `Google Chrome for Testing 149.0.7827.55`, exit 0
  - `--headless --no-sandbox --disable-gpu --dump-dom "data:text/html,<h1>hello</h1>"`
    → renders clean, exit 0
- **Not zombie procs.** Killed all `chrome-headless-shell` / `crashpad_handler`.
  A stuck `crashpad_handler` (was pid 44324) was cleared. Launch still hangs after.
- The 17 `chrome.exe` procs on the machine are **Helium** (user's real browser,
  `AppData\Local\imput\Helium`) — NOT orphaned Playwright. Do NOT kill them.
- Isolated minimal launch (`/tmp/pw-launch-test.mjs`, also copied to project as
  `./pw-launch-test.mjs`) reproduces the hang under **bun** → so it's env, not
  record-cockpit.mjs.

### Key detail
- Standalone binary works, but Playwright's **pipe transport (fd 3/4) handshake**
  hangs. Classic Windows handle-inheritance failure on `--remote-debugging-pipe`.
- It **worked earlier this same session** (earlier cockpit/analyse captures
  produced frames + rendered clips). Regressed mid-session.

### Next things to try (in order)
1. Force websocket transport instead of pipe. Playwright uses pipe by default;
   try connecting via `--remote-debugging-port` + `chromium.connectOverCDP`, or
   check for an env toggle. (Pipe handshake is the exact failing part.)
2. Try `channel: 'chrome'` / `channel: 'msedge'` launch (uses installed browser,
   different launch path than bundled headless-shell).
3. Test launch under **node** to confirm bun-specific handle bug. NOTE: node test
   currently fails with `ERR_MODULE_NOT_FOUND` for `@playwright/test` because deps
   are bun-installed — node's ESM resolver can't find the package. Fix module
   resolution first (e.g. run from correct cwd / `npm`-style install / or use a
   CJS require shim) before this test is meaningful.
4. If bun handle-inheritance is the root cause, run the capture via node once
   module resolution is sorted, or restart the bun/terminal session.

## Cleanup notes
- Temp test file `pw-launch-test.mjs` was copied into repo root — delete it.
- Frames dir: `C:\Users\acoop\AppData\Local\Temp\raceiq-cockpit-frames`.

## Do NOT
- Do not kill Helium `chrome.exe` processes (user's browser).
- Do not revert unrelated edits to `raceiq-showcase\index.html` — prior turns
  noted it was intentionally modified.
