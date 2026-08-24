# Build Scripts

Build and package RaceIQ artifacts from repository root.

| Command | Purpose |
|---|---|
| `bun scripts/build/build.ts` | Clean `dist`, build client, copy runtime data/assets, compile server binary, copy native libsql addon. |
| `bun scripts/build/build-installer.ts [version]` | Build client, copy data, compile Windows binary, and run Inno Setup. Defaults version to `package.json`. |
| `bun scripts/build/bundle-client.ts` | Embed `client/dist` assets in `server/client-assets.generated.ts`. |
| `bun scripts/build/copy-client-dist.ts` | Copy `client/dist` to `dist/public`. |
| `bun scripts/build/copy-shared-data.ts` | Copy shared runtime data, including canonical track registry and geometry assets, plus `credstore.ps1` into `dist`. |
| `bun scripts/build/patch-pe-gui.ts <exe>` | Change Windows PE subsystem from console to GUI. |

Inputs: repository `client`, `shared`, `server`, `assets`, and installed dependencies. Outputs: `dist`, generated client asset module, or patched executable as applicable.

Boundary: build scripts own packaging and artifact preparation only. They do not own application runtime logic, installer definitions, or release metadata.

Focused verification: run each command with its documented input from repository root; inspect expected output paths and exit status.
