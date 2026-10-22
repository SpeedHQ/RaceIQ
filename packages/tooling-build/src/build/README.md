# Build Scripts

Build and package RaceIQ artifacts from repository root.

| Command | Purpose |
|---|---|
| `bun packages/tooling-build/src/build/build.ts` | Clean `dist`, build client, copy runtime data/assets, compile server binary, ad-hoc sign and verify it on macOS, copy native libsql addon. |
| `bun packages/tooling-build/src/build/build-installer.ts [version]` | Build client, copy data, compile Windows binary, and run Inno Setup. Defaults version to `package.json`. |
| `bun packages/tooling-build/src/build/build-icon.ts` | Render Windows ICO frames (16–256px) from the official 1024px `assets/raceiq-icon.png` logo using Sharp. |
| `bun packages/tooling-build/src/build/bundle-client.ts` | Embed `client/dist` assets in `server/client-assets.generated.ts`. |
| `bun packages/tooling-build/src/build/copy-client-dist.ts` | Copy `client/dist` to `dist/public`. |
| `bun packages/tooling-build/src/build/copy-shared-data.ts` | Copy shared CSV/JSON data, game-owned runtime assets, and `credstore.ps1` into `dist`. |
| `bun packages/tooling-build/src/build/patch-pe-gui.ts <exe>` | Change Windows PE subsystem from console to GUI. |


## Live-engineer voice pack

Generated Qwen source lives in `assets/live-engineer/qwen-v3/` and is not copied into the application build. `packages/live-engineer/audio-package.json` pins engine compatibility, locale and minimum pack revision. `shared/racing/live/audio-catalog-version.json` independently pins semantic catalog compatibility (`1.0.0`); `qwen-v3` identifies generation/storage, not a catalog version. TypeScript and Python consume the same JSON sources. Build with `bun run voice:pack:build [output.zip]`; default `live-engineer-qwen-v3-en-1.0.0.zip` stays outside app `dist`, accompanied by same-basename JSON metadata containing release identity and ZIP SHA-256. Install with `bun run voice:pack:install <zip-path-or-url>`.

The Node-only `@raceiq/live-engineer/audio-installation` installer accepts compatible package revisions at or above the pinned minimum, while callers can require an exact selected revision and optional ZIP SHA-256. It validates engine/package compatibility, language, catalog, manifest paths, and SHA-256 for every clip before staged replacement; failures preserve existing audio. Installed files live under `<DATA_DIR>/userdata/voice-packs/live-engineer/qwen-v3` (source) or `%APPDATA%/RaceIQ/userdata/voice-packs/live-engineer/qwen-v3` (compiled). Runtime serves `/audio/live-engineer/qwen-v3/<path>`; missing files return 404, not the dashboard fallback. Without Bun, extract ZIP contents preserving `live-engineer/qwen-v3/` into the applicable `voice-packs` directory.

Change segment IDs, recipes or their semantic contract: bump shared `catalogVersion` and pack revision, then regenerate manifest metadata. Change recordings/voice pronunciation without changing the catalog contract: bump `packageVersion` only. Change the engine's pack-format/runtime compatibility: bump `engineVersion`. A translated pack may reuse a compatible catalog while declaring its own locale and revision; no language selector exists yet. Run `.github/workflows/voice-pack.yml` manually to publish immutable tag `voice-pack-<language>-v<packageVersion>` plus same-basename ZIP and JSON metadata. App releases do not republish audio; voice releases do not replace the latest app release. Publish required voice release before distributing the app. Native/human listening approval remains separate.
Inputs: repository `client`, `shared`, `server`, `packages/game-*/assets`, root `assets`, and installed dependencies. Outputs: `dist`, root `assets/raceiq.ico`, generated client asset module, or patched executable as applicable.

Game packages own car images and track SVG sources under `assets/`. Public car images retain their URL paths under `assets/public/` and ship through the client build to `dist/public`. Backend/geometry assets ship to `dist/data/games/<game>/`, preserving catalog-relative paths. Catalogs and curated/generated track data retain their existing shared and writable roots.

macOS builds require `codesign`: Bun's compiled binary may have an invalid signature that causes immediate termination before server startup. Build script re-signs final executable locally; release distribution still needs its own signing and notarization.

Boundary: build scripts own packaging and artifact preparation only. They do not own application runtime logic, installer definitions, or release metadata.

Focused verification: run each command with its documented input from repository root; inspect expected output paths and exit status.
