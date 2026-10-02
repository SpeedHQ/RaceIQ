# Release Scripts

Validate and render release metadata.

| Command | Purpose |
|---|---|
| `bun scripts/release/check-changelog.ts` | In pull-request CI, require a new note under `## Unreleased`; no-op outside pull requests. |
| `bun scripts/release/generate-release-note.ts <version>` | Render `CHANGELOG.md`'s unreleased body for the GitHub release body. |

Inputs: `CHANGELOG.md`, git base ref and event variables for CI validation, and release version argument for rendering. Outputs: validation status or the draft release body.

Boundary: release-note validation/rendering only. Scripts do not publish releases, edit changelog content, or build artifacts.

Focused verification: run changelog check with pull-request environment variables against a diff containing an Unreleased note; run generator with a version and inspect both output files.
