---
name: update-release-notes
description: Update RaceIQ release notes on a pull-request branch. Use whenever a PR adds, fixes, changes, or removes user-visible behavior, or when asked to update CHANGELOG.md, release notes, or changelog entries. Ensures the note is recorded under Unreleased and validates the release-note artifact workflow.
---

# Update release notes

Use this skill on the PR branch before opening or updating a pull request.

## Workflow

1. Read `CHANGELOG.md` and inspect the branch diff.
2. Add one concise bullet under the matching `## Unreleased` subsection:
   - `Breaking`: migration, compatibility, default, route, or user-config changes that prevent clean rollback.
   - `Features`: new user-facing capability.
   - `Fixes`: corrected user-visible behavior.
   - `Internal`: implementation, CI, tooling, or maintenance work invisible to users.
3. Preserve the section order `Breaking`, `Features`, `Fixes`, `Internal`. Create a missing subsection only when needed.
4. Keep `### Fixes` and `### Internal` headings in `## Unreleased` even when they have no bullets.
5. Do not edit a released version section. Do not duplicate an existing bullet.
6. Run `bun test test/changelog.test.ts --timeout 60000` and report the changed files.

## Writing rules

- Write `Breaking`, `Features`, and `Fixes` notes for the user, describing what they can now do or what behavior changed.
- Do not mention files, functions, implementation details, CI, or internal process in user-facing sections.
- Use imperative or concise present tense and keep one change per bullet; avoid issue/PR metadata.
- Put implementation, CI, tooling, and maintenance work only under `Internal`; Internal notes are stripped from published release-note artifacts.

## Pull-request checklist

Before requesting review, confirm:

- `CHANGELOG.md` contains a new bullet under `## Unreleased`.
- The bullet is in the correct category.
- The release workflow will generate `releasenote.md` (current release) and `releasenotes.md` (full public history).
- Changelog tests pass.
