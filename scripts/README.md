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
| [`games/`](games/) | Installed-game extraction and format-specific tooling |
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

## Verification

Use narrow proof first:

```sh
bun run typecheck:scripts
bun test <focused-test-file> --timeout 30000
```

Generators and destructive data commands require their domain-specific checks. Telemetry catalog changes must pass `bun run telemetry:catalog:check`; database seeding changes must use isolated `DATA_DIR`.
