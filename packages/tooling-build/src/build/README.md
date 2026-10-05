# Build Scripts

Build and package RaceIQ artifacts from repository root.

| Command | Purpose |
|---|---|
| `bun packages/tooling-build/src/build/build.ts` | Clean `dist`, build client and Rust recorder, copy runtime data/assets, compile server binary, ad-hoc sign and verify executables on macOS, copy native libsql addon. |
| `bun packages/tooling-build/src/build/build-installer.ts [version]` | Build client, copy data, compile Windows binary, and run Inno Setup. Defaults version to `package.json`. |
| `bun run build:recorder` | Build the debug Rust recorder for source development with the pinned Rust 1.90.0 toolchain. |
| `bun packages/tooling-build/src/build/build-recorder-cli.ts --release` | Build and stage the release recorder in `dist`, including macOS executable signing. |
| `bun packages/tooling-build/src/build/build-icon.ts` | Render Windows ICO frames (16–256px) from the official 1024px `assets/raceiq-icon.png` logo using Sharp. |
| `bun packages/tooling-build/src/build/bundle-client.ts` | Embed `client/dist` assets in `server/client-assets.generated.ts`. |
| `bun packages/tooling-build/src/build/copy-client-dist.ts` | Copy `client/dist` to `dist/public`. |
| `bun packages/tooling-build/src/build/copy-shared-data.ts` | Copy shared CSV/JSON data, game-owned runtime assets, and `credstore.ps1` into `dist`. |
| `bun packages/tooling-build/src/build/patch-pe-gui.ts <exe>` | Change Windows PE subsystem from console to GUI. |

Inputs: repository `client`, `shared`, `server`, `packages/game-*/assets`, root `assets`, and installed dependencies. Outputs: `dist`, root `assets/raceiq.ico`, generated client asset module, or patched executable as applicable.

Game packages own car images and track SVG sources under `assets/`. Public car images retain their URL paths under `assets/public/` and ship through the client build to `dist/public`. Backend/geometry assets ship to `dist/data/games/<game>/`, preserving catalog-relative paths. Catalogs and curated/generated track data retain their existing shared and writable roots.

macOS builds require `codesign`: Bun's compiled binary may have an invalid signature that causes immediate termination before server startup. Build script re-signs final executable locally; release distribution still needs its own signing and notarization.

The recorder is mandatory in distribution bundles, even though Bun remains the default engine. Host builds stage `raceiq-recorder` beside the backend; Windows releases/installers stage `raceiq-recorder.exe`. Missing toolchains, target artifacts, or signing failures abort the build. `RACEIQ_RECORDER_PREBUILT_PATH` supplies an explicit already-built artifact when the host build cannot compile it locally; release/installer targets require the matching Windows artifact. Native Windows shared-memory and installer checks require a Windows host.

Boundary: build scripts own packaging and artifact preparation only. They do not own application runtime logic, installer definitions, or release metadata.

Focused verification: run each command with its documented input from repository root; inspect expected output paths and exit status.
