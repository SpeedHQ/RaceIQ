# Release Note Versioning Design

## Goal

When a GitHub release is published, generated release-note assets must identify the published release instead of retaining `## Unreleased`. The source changelog must then be ready for the next development cycle.

## Behavior

`releasenotes.md` is generated from the changelog content that was used for the release and starts with:

```md
## vX.Y.Z - YYYY-MM-DD
```

The version comes from the release tag and the date comes from `github.event.release.published_at`, formatted as the ISO calendar date. Existing released sections remain in their current order and public rendering continues to omit `### Internal` sections.

`releasenote.md` remains the current release body: public `Features`, `Fixes`, and `Breaking` sections only, with no `Internal` section.

After the release assets are regenerated, CI updates the committed `CHANGELOG.md` by replacing the consumed `## Unreleased` section with the published `## vX.Y.Z - YYYY-MM-DD` section and prepending a new empty block:

```md
## Unreleased

### Features

### Fixes

### Internal
```

The changelog update is committed alongside the existing package-version bump during the release finalization job.

## Implementation

- Extend the changelog renderer/generator boundary so the full-history renderer can receive the target version and ISO date rather than hard-coding `Unreleased`.
- Validate the generator’s version/date inputs and preserve the existing single-release body output.
- Add a release-finalization helper or script for the changelog rollover, keeping markdown parsing in shared code rather than shell substitutions.
- Keep the draft build’s existing generation and upload unchanged; the `release` event regenerates both files with the publication date and uploads them to the existing release with `--clobber`.
- Commit the version and changelog rollover in the existing finalize job.

## Error handling

Missing or malformed version/date input must fail the generator before writing artifacts. A changelog without a usable `## Unreleased` section must fail the release workflow rather than silently producing incomplete notes.

## Tests

Focused tests cover:

- full-history heading replacement with the requested tag version and ISO date;
- date formatting from a publication timestamp;
- preservation of released-section order and omission of `Internal`;
- creation of the empty next `Unreleased` sections;
- unchanged current-release body rendering.

The targeted changelog test suite and generator smoke path provide verification; the full project suite is not required for this markdown/workflow-only change.
