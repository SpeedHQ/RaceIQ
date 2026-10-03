# Build Scripts

Build and package RaceIQ artifacts from repository root.

| Command | Purpose |
|---|---|
| `bun scripts/build/build.ts` | Clean `dist`, build client, copy runtime data/assets, compile server binary, ad-hoc sign and verify it on macOS, copy native libsql addon. |
| `bun scripts/build/build-installer.ts [version]` | Build client, copy data, compile Windows binary, and run Inno Setup. Defaults version to `package.json`. |
| `bun scripts/build/bundle-client.ts` | Embed `client/dist` assets in `server/client-assets.generated.ts`. |
| `bun scripts/build/copy-client-dist.ts` | Copy `client/dist` to `dist/public`. |
| `bun scripts/build/copy-shared-data.ts` | Copy shared CSV/JSON data, game-owned runtime assets, and `credstore.ps1` into `dist`. |
| `bun scripts/build/patch-pe-gui.ts <exe>` | Change Windows PE subsystem from console to GUI. |

Inputs: repository `client`, `shared`, `server`, `packages/game-*/assets`, `assets`, and installed dependencies. Outputs: `dist`, generated client asset module, or patched executable as applicable.

Game packages own car images and track SVG sources under `assets/`. Public car images retain their URL paths under `assets/public/` and ship through the client build to `dist/public`. Backend/geometry assets ship to `dist/data/games/<game>/`, preserving catalog-relative paths. Catalogs and curated/generated track data retain their existing shared and writable roots.

macOS builds require `codesign`: Bun's compiled binary may have an invalid signature that causes immediate termination before server startup. Build script re-signs final executable locally; release distribution still needs its own signing and notarization.

Boundary: build scripts own packaging and artifact preparation only. They do not own application runtime logic, installer definitions, or release metadata.

Focused verification: run each command with its documented input from repository root; inspect expected output paths and exit status.
