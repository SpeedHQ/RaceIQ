# Repository scripts

## Purpose

Operational, maintenance, extraction, and development commands live here. Prefer stable `bun run <name>` package commands for routine work. Invoke a file directly only for documented specialist or diagnostic workflows.

## Directory map

| Directory | Ownership |
| --- | --- |
| [`build/`](build/) | Application assembly, installer creation, asset copying, and executable patching |
| [`catalog/`](catalog/) | Semantic telemetry catalog generation and source capture |
| [`data/`](data/) | Database seeding, lap archives, demos, and data maintenance |
| [`dev/`](dev/) | Local process orchestration, proxying, and Mastra Studio |
| [`games/`](games/) | Bundled-data imports and game metadata utilities |
| [`iracing/`](iracing/) | iRacing probes, catalog seeding, and fixture generation |
| [`lib/`](lib/) | Side-effect-free helpers shared by multiple script domains |
| [`quality/`](quality/) | Bench comparison, AI baselines, and updater checks |
| [`release/`](release/) | Changelog validation and release-note generation |
| [`scrapers/`](scrapers/) | Rate-limited external catalog scrapers |
| [`telemetry/`](telemetry/) | Raw recording and simulator-specific diagnostics |
| [`tracks/`](tracks/) | Track curation, migration, coverage, and guide snapshots |
| [`ui/`](ui/) | Screenshot collection and local visual-diff reports |

Each directory README documents its entrypoints, prerequisites, inputs, outputs, and focused checks.

## Boundaries

- Entrypoints own argument parsing, logging, process exit behavior, and filesystem or network side effects.
- Importable helpers must be side-effect-free. Guard reusable executable modules with `import.meta.main`.
- Extract a shared helper only after two consumers need identical behavior. Keep simulator and file-format policy in owning domain.
- Import explicit leaves. Do not add barrels that hide script dependencies.
- Resolve repository-owned files from `import.meta.dir`; do not require caller working directory unless CLI explicitly documents that contract.
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

Root suite commands dispatch Turbo tasks through `scripts/test/run-turbo.ts`,
which hashes platform, architecture, and Bun version. Ordinary suites cache
successful results; recording/native tasks and production builds stay uncached.
The `transit` task hashes dependency implementation and helpers, excluding only
test-case files so dependency-only test edits do not invalidate consumers.

```sh
bun run test:integration -- --filter=@raceiq/game-acc --summarize
bun scripts/test/run-turbo.ts test:unit test:tooling test:integration --affected
```

Affected runs require resolvable `TURBO_SCM_BASE` and `TURBO_SCM_HEAD`; otherwise
the wrapper runs full selection. CI cache partitions include host and toolchain.
Application, tooling, and frontend contract tasks compile client translations
explicitly; game/core tasks do not depend on client compilation.

## Verification

Use narrow proof first:

```sh
bun run typecheck:scripts
bun test <focused-test-file> --timeout 30000
```

Generators and destructive data commands require their domain-specific checks. Telemetry catalog changes must pass `bun run telemetry:catalog:check`; database seeding changes must use isolated `DATA_DIR`.
