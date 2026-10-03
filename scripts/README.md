# Repository scripts

## Purpose

`scripts/` owns the `@raceiq/tooling` control plane: test runners, development processes, CI orchestration, i18n, and quality commands. Responsibility-specific source lives in private `packages/tooling-*` workspaces. Stable `bun run <name>` commands remain unchanged.

## Directory map

| Directory | Ownership |
| --- | --- |
| [`dev/`](dev/) | Local process orchestration, proxying, and Mastra Studio |
| [`test/`](test/) | Owner discovery, suite dispatch, shard validation, and benchmarks |
| [`ci/`](ci/) | Workflow orchestration and release-version selection |
| [`i18n/`](i18n/) | Translation maintenance |
| [`quality/`](quality/) | Bench comparison, AI baselines, and updater checks |
| [`tooling-build`](../packages/tooling-build/src/) | Application assembly, installers, runtime copying, and model/image optimization |
| [`tooling-catalog`](../packages/tooling-catalog/src/catalog/) | Semantic telemetry catalog generation and source capture |
| [`tooling-data`](../packages/tooling-data/src/) | Database helpers, demos, probes, fixtures, scrapers, and track maintenance |
| [`tooling-marketing`](../packages/tooling-marketing/src/marketing/) | Marketing track-wall fixtures and exports |
| [`tooling-release`](../packages/tooling-release/src/) | Changelog parsing, validation, release notes, and development release flags |
| [`tooling-ui`](../packages/tooling-ui/src/ui/) | Screenshot collection, Storybook builds, and visual-diff reports |

Each directory README documents its entrypoints, prerequisites, inputs, outputs, and focused checks.

## Boundaries

- Entrypoints own argument parsing, logging, process exit behavior, and filesystem or network side effects.
- Importable helpers must be side-effect-free. Guard reusable executable modules with `import.meta.main`.
- Extract a shared helper only after two consumers need identical behavior. Keep simulator and file-format policy in owning domain.
- Import explicit leaves. Do not add barrels that hide script dependencies.
- Responsibility packages resolve repository-owned files through their local `src/root.ts` constant. Do not require caller working directory unless the CLI explicitly documents that contract.
- Use kebab-case filenames and canonical game IDs such as `ac-evo`, `f1-2025`, and `fm-2023`.
- Generated data belongs in owning `shared/`, `test/artifacts/`, `client/public/`, or `dist/` location—not beside script source.

## Stable commands

Common package commands include:

```sh
bun run dev
bun run build
bun run db:seed
bun run telemetry:catalog:check
bun run tracks:coverage
bun run ui:diff
```

See `package.json` for full stable command list. Direct commands and specialist flags live in domain READMEs.

## Workspace test suites

Ordinary backend tests live in their owning workspace's `test/` tree. Local
`test/<suite>-files.txt` manifests contain repository-root-relative paths and
retain unit, tooling, integration, and recording E2E classifications.

Responsibility packages expose only used module leaves and declare actual source dependencies. Applications import release/data/catalog owners directly, never the control plane. Release and optimizer suites do not inherit client compilation or backend task dependencies. UI tests use temporary screenshot and Storybook fixtures; only the optimizer tooling suite hashes the three real source GLBs. DuckDB copying retains its original unit classification.

```sh
bun run test:shards
bun scripts/test/run-suite.ts integration --package @raceiq/game-acc
bun scripts/test/run-suite.ts all --package @raceiq/backend
```

Owners are discovered from root workspaces. Coverage rejects unassigned tests,
cross-owner entries, duplicates, stale paths, and traversal. Omit absent suites;
requesting an absent suite explicitly fails. `all` runs present suites in
unit → tooling → integration → E2E order, stopping at the first failure.

Every owner/suite gets a fresh temporary `DATA_DIR`, regardless of inherited
production paths. Unit runs have no DB preload; other suites run serially with
neutral DB setup. Only application and frontend contract owners preload
application assembly. Immutable fixtures and output locations remain at root.

Concrete adapters and catalogs belong to six `@raceiq/game-<id>-metadata` owners; cross-game registration and catalog composition belong to `@raceiq/game-catalogs`. A metadata implementation edit leaves neutral shared transit and other metadata owners unchanged. Backend composition still legitimately depends on all games. Non-unit teardown actually reads the Forza, F1, and iRacing `tracks.csv` catalogs; those three paths remain explicit common non-unit inputs. Unit suites do not inherit those preload inputs.

Closed lap-analysis and telemetry algorithms belong to `@raceiq/analysis-core` and `@raceiq/telemetry-core`; their suite tasks depend only on their own transit. Shared retains capability defaults, packet/catalog contracts, and version identities. Browser consumers import algorithm leaves directly; the Node live projector is a separate telemetry-core export. Non-unit suites still hash the real isolated-database preload closure.

Dependency-free speed, distance, temperature, and lap-time helpers belong to `@raceiq/frontend-pure`. Its three test files run as a unit-only owner, without client compilation, backend preload, or workspace dependencies. Run `bun scripts/test/run-suite.ts unit --package @raceiq/frontend-pure`. Frontend composition assertions remain in `@raceiq/frontend-contract-tests`, including per-wheel telemetry fidelity and shared/client trace contracts.

Root suite commands dispatch Turbo tasks through `scripts/test/run-turbo.ts`,
which hashes platform, architecture, and Bun version. Ordinary suites cache
successful results; recording/native tasks and production builds stay uncached.
The `transit` task excludes test cases and suite manifests. Application and
control-plane owners also exclude proven test-only local support; exported
game/backend helpers used by production tools remain transit inputs.
Root suite inputs cover launcher/configuration files and the actual nonunit
preload source closure. External recordings, diagnostics, setup files, and
model assets belong to the consuming owner/suite, not root defaults.
Package overrides use `$TURBO_EXTENDS$` to retain launcher inputs. Aggregate
`test` inputs are the union of that owner's suite inputs.

```sh
bun run test:integration -- --filter=@raceiq/game-acc --summarize
bun scripts/test/run-turbo.ts test:unit test:tooling test:integration --affected
```

Affected runs require resolvable `TURBO_SCM_BASE` and `TURBO_SCM_HEAD`; otherwise
the wrapper runs full selection. CI cache partitions include host and toolchain.
Application, tooling, and frontend contract tasks compile client translations
explicitly; game/core tasks do not depend on client compilation.

Root `bun run typecheck` checks workspace packages sequentially. The shared
base config uses `${configDir}/dist`, giving each composite workspace its own
incremental cache instead of overwriting root `dist/tsconfig.tsbuildinfo`.
Shared cache state can produce a locationless backend `TS2589`; an isolated
cache checks the same complete project successfully. Every source/test file,
strict check, and the full typed RPC contract remains covered.

## Verification

Use narrow proof first:

```sh
bun run typecheck:scripts
bun test <focused-test-file> --timeout 30000
```

Generators and destructive data commands require their domain-specific checks. Telemetry catalog changes must pass `bun run telemetry:catalog:check`; database seeding changes must use isolated `DATA_DIR`.

## External test input matrix

Paths below are repository-relative. Each aggregate `test` hashes its owner's union. Unit/tooling suites without listed external inputs inherit only common launcher/configuration inputs and owner source; nonunit suites additionally hash the explicit preload source closure in root `turbo.json`. Outputs are not fixture inputs.

| Owner | Suite | External inputs |
|---|---|---|
| `@raceiq/tooling` | `test:tooling` | `assets/models/source/f1_2025_mclaren_mcl39.glb`<br>`assets/models/source/aston_martin_vantage_gt3.glb`<br>`assets/models/source/peugeot_9x8_evo_2024.glb`<br>`client/src/**`<br>`client/DESIGN.md`<br>`client/.impeccable/design.json`<br>`client/.storybook/preview.ts` |
| `@raceiq/backend` | `test:integration` | `test/artifacts/sessions/*.bin.gz`<br>`test/artifacts/sessions/iracing-road-america-gt3.bin.gz`<br>`test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz`<br>`test/artifacts/sessions/fm-2023-with-pitting.bin.gz`<br>`test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz`<br>`test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz`<br>`test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz`<br>`test/artifacts/carsetup/*.carsetup`<br>`test/artifacts/motec/acc-barcelona-porsche-992.zip`<br>`shared/data/tracks/meta/*.json`<br>`data/diagnostics/iracing-session-info/*.json`<br>`data/diagnostics/iracing-session-info/iracing-all-vars-2026-07-29T02-06-39-162Z.json` |
| `@raceiq/backend` | `test:e2e:recordings` | `test/artifacts/motec/acc-barcelona-porsche-992.zip`<br>`test/artifacts/sessions/fm-2023-2026-04-09T21-53-00-102Z.bin.gz`<br>`test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz`<br>`test/artifacts/sessions/acc-2026-04-10T02-55-22-777Z.bin.gz`<br>`test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz`<br>`test/artifacts/sessions/acc-2026-04-10T02-59-28-972Z.bin.gz`<br>`test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz`<br>`test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz`<br>`test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz`<br>`test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz` |
| `@raceiq/frontend-contract-tests` | `test:integration` | `test/artifacts/carsetup/mustang.carsetup`<br>`test/artifacts/carsetup/Tourist.carsetup`<br>`test/artifacts/carsetup/Default-12312.carsetup` |
| `@raceiq/game-acc` | `test:integration` | `test/artifacts/sessions/acc-2026-04-10T02-55-22-777Z.bin.gz`<br>`test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz`<br>`test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz` |
| `@raceiq/game-acc` | `test:e2e:recordings` | `test/artifacts/sessions/acc-2026-04-10T02-59-28-972Z.bin.gz`<br>`test/artifacts/sessions/acc-2026-04-12T20-41-21-436Z.bin.gz`<br>`test/artifacts/sessions/acc-2026-04-12T21-16-07-841Z.bin.gz`<br>`test/artifacts/sessions/acc-2026-04-12T21-44-38-899Z.bin.gz` |
| `@raceiq/game-ac-evo` | `test:integration` | `test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz`<br>`test/artifacts/carsetup/Default-12312.carsetup`<br>`test/artifacts/carsetup/audi-default-3.carsetup`<br>`test/artifacts/carsetup/F1 default.carsetup`<br>`test/artifacts/carsetup/F1 default 2.carsetup` |
| `@raceiq/game-ac-evo` | `test:e2e:recordings` | `test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz`<br>`test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz`<br>`test/artifacts/sessions/session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz` |
| `@raceiq/game-f1-2025` | `test:integration` | `test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz`<br>`test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz` |
| `@raceiq/game-f1-2025` | `test:e2e:recordings` | `test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz` |
| `@raceiq/game-fm-2023` | `test:e2e:recordings` | `test/artifacts/sessions/fm-2023-2026-04-09T21-53-00-102Z.bin.gz`<br>`test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz`<br>`test/artifacts/sessions/fm-2023-with-pitting.bin.gz` |
| `@raceiq/game-iracing` | `test:integration` | `test/artifacts/sessions/iracing-road-america-gt3.bin.gz` |
| `@raceiq/game-iracing` | `test:e2e:recordings` | `test/artifacts/sessions/iracing-road-america-gt3.bin.gz`<br>`test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz` |
| `@raceiq/game-lmu` | `test:e2e:recordings` | `test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz`<br>`test/artifacts/laps/lmu-2026-09-19T20-09-44-686Z.bin.gz`<br>`test/artifacts/laps/lmu-2026-09-22T21-18-23-218Z.bin.gz.part1`<br>`test/artifacts/laps/lmu-2026-09-22T21-18-23-218Z.bin.gz.part2` |

Exported game/backend test support remains in transit when runtime tools consume it. Update this matrix with source/test ownership changes; directory scans require matching globs, not a sampled filename.

