# Release Note Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish release-note assets with the release tag/date and roll `CHANGELOG.md` forward to a fresh empty `Unreleased` section during release finalization.

**Architecture:** Keep markdown semantics in `shared/changelog.ts`. Add explicit target-release rendering and a changelog rollover function there; the generator script formats the publication timestamp and writes assets. The release workflow regenerates and replaces both assets on the `release` event before committing the package-version and changelog rollover.

**Tech Stack:** Bun, TypeScript, Bun test runner, GitHub Actions, GitHub CLI.

## Global Constraints

- `releasenotes.md` must start with `## vX.Y.Z - YYYY-MM-DD` for published releases.
- `releasenote.md` remains the current public release body and omits `### Internal`.
- Existing released sections remain unchanged and ordered.
- The source changelog rollover preserves the consumed release content, including `### Internal`.
- The next source `## Unreleased` block contains empty `### Features`, `### Fixes`, and `### Internal` sections.
- The release workflow must continue uploading both `releasenote.md` and `releasenotes.md`.
- No dynamic imports.

---

### Task 1: Add target-release rendering and changelog rollover

**Files:**
- Modify: `shared/changelog.ts`
- Test: `test/changelog.test.ts`

**Interfaces:**
- Produces `renderAllReleaseNotes(markdown: string, release?: { version: string; date?: string }): string`.
- Produces `rolloverChangelog(markdown: string, release: { version: string; date: string }): string`.

- [ ] **Step 1: Add failing renderer tests**

Extend the changelog parser tests with a target-release case:

```ts
test("renders the requested release heading for full history", () => {
  expect(renderAllReleaseNotes(`
## Unreleased

### Features
- New feature

### Internal
- Refactor

## v0.13.0 - 2026-07-16

### Fixes
- Old fix
`, { version: "0.14.0", date: "2026-08-05" })).toBe(
    "## v0.14.0 - 2026-08-05\n\n### Features\n- New feature\n\n## v0.13.0 - 2026-07-16\n\n### Fixes\n- Old fix",
  );
});
```

Add a rollover case proving source-only `Internal` preservation and empty next sections:

```ts
test("rolls the released Unreleased block forward", () => {
  expect(rolloverChangelog(`
## Unreleased

### Features
- New feature

### Internal
- Refactor

## v0.13.0 - 2026-07-16

### Fixes
- Old fix
`, { version: "0.14.0", date: "2026-08-05" })).toBe(`## Unreleased

### Features

### Fixes

### Internal

## v0.14.0 - 2026-08-05

### Features
- New feature

### Internal
- Refactor

## v0.13.0 - 2026-07-16

### Fixes
- Old fix`);
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run `bun test test/changelog.test.ts --timeout 30000` from the worktree. Expected: FAIL because the new optional release argument and rollover function do not exist.

- [ ] **Step 3: Implement the renderer changes**

Change `renderAllReleaseNotes` so it pushes the rendered unreleased body under `## Unreleased` when no release argument is provided (preserving existing callers/tests), and under `## v${version} - ${date}` when a release argument is provided. The release date suffix is included only when `date` is non-empty.

Implement `rolloverChangelog` by locating the exact top-level `## Unreleased` block, retaining its raw body through the next top-level `##` heading, rendering the new release heading with the raw body trimmed, and prepending this empty block:

```ts
const EMPTY_UNRELEASED = "## Unreleased\n\n### Features\n\n### Fixes\n\n### Internal";
```

Throw an `Error` when no `## Unreleased` heading exists. Do not pass the consumed body through `renderReleaseBody`; source `CHANGELOG.md` must retain `Internal` and original category content.

- [ ] **Step 4: Run the focused test to verify success**

Run `bun test test/changelog.test.ts --timeout 30000`. Expected: PASS, including existing parser, public-rendering, and CI-check tests.

- [ ] **Step 5: Commit the shared behavior**

Run:

```bash
git add shared/changelog.ts test/changelog.test.ts
git commit -m "feat: version generated release notes"
```

---

### Task 2: Make the generator accept publication timestamps

**Files:**
- Modify: `scripts/generate-release-note.ts`
- Modify: `shared/changelog.ts`
- Test: `test/changelog.test.ts`

**Interfaces:**
- CLI remains `bun scripts/generate-release-note.ts <version> [publishedAt]`.
- `formatReleaseDate(value: string): string` lives in `shared/changelog.ts`, parses an ISO timestamp, and returns the UTC `YYYY-MM-DD` date.
- `publishedAt`, when supplied, is an ISO timestamp from `github.event.release.published_at`; the script formats it through `formatReleaseDate`.

- [ ] **Step 1: Add date-formatting coverage**

Import `formatReleaseDate` from `shared/changelog.ts` and add:

```ts
test("formats a publication timestamp as a UTC ISO date", () => {
  expect(formatReleaseDate("2026-08-05T23:30:00-07:00")).toBe("2026-08-06");
});
```

Also cover invalid input:

```ts
test("rejects an invalid publication timestamp", () => {
  expect(() => formatReleaseDate("not-a-date")).toThrow("Invalid release date");
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run `bun test test/changelog.test.ts --timeout 30000`. Expected: FAIL because `formatReleaseDate` is absent.

- [ ] **Step 3: Implement generator date handling**

Implement `formatReleaseDate(value: string): string` in `shared/changelog.ts`. Parse with `new Date(value)`, reject `Number.isNaN(date.getTime())`, and return `date.toISOString().slice(0, 10)`.

Keep the required version argument. Read the optional timestamp argument. For the full-history asset, pass `{ version, date: formatReleaseDate(publishedAt) }` when a timestamp exists; when the draft build has no timestamp, pass `{ version }`, producing `## vX.Y.Z` until finalization regenerates it. Keep `releasenote.md` sourced from `renderUnreleasedBody` exactly as before.

Update the usage error to `Usage: bun scripts/generate-release-note.ts <version> [publishedAt]` and reject an explicitly supplied invalid timestamp before writing either file.

- [ ] **Step 4: Run generator smoke checks**

Run from the worktree:

```bash
rm -f releasenote.md releasenotes.md
bun scripts/generate-release-note.ts 0.14.0 2026-08-05T23:30:00Z
```

Expected: both files are written; `releasenotes.md` begins `## v0.14.0 - 2026-08-05`; `releasenote.md` contains no `### Internal`.

- [ ] **Step 5: Commit the generator behavior**

Run:

```bash
git add scripts/generate-release-note.ts shared/changelog.ts test/changelog.test.ts
git commit -m "feat: date release note assets"
```


---

### Task 3: Finalize release assets and source changelog in CI

**Files:**
- Modify: `.github/workflows/release.yml`
- Create: `scripts/rollover-changelog.ts`
**Interfaces:**
- Consumes `github.event.release.tag_name` and `github.event.release.published_at`.
- Calls `bun scripts/generate-release-note.ts <version> <publishedAt>`.
- Calls `bun scripts/rollover-changelog.ts <version> <publishedAt>`.
- Uploads both generated files to the published release with `gh release upload --clobber`.
- Commits `package.json` and `CHANGELOG.md` to `main`.
- [ ] **Step 1: Add publication regeneration to `finalize`**

After checkout and before the package-version commit, add a step that derives `TAG`, `VERSION`, and `PUBLISHED_AT`, runs:

```bash
bun scripts/generate-release-note.ts "$VERSION" "$PUBLISHED_AT"
gh release upload "$TAG" releasenote.md releasenotes.md --clobber
```

Set `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` on that step. This replaces both assets created by the draft build and preserves the existing upload behavior.

- [ ] **Step 2: Add changelog rollover to the finalize commit**

Implement `scripts/rollover-changelog.ts` as a CLI accepting `<version> <publishedAt>`. It reads `CHANGELOG.md`, calls `formatReleaseDate(publishedAt)` and `rolloverChangelog(markdown, { version, date })`, then writes the returned markdown back to `CHANGELOG.md`. The helper must preserve the consumed raw release body, including `Internal`, and prepend the empty three-category `Unreleased` block. It must fail before writing when arguments are missing, the timestamp is invalid, or `CHANGELOG.md` has no `## Unreleased` heading. Do not use a YAML `sed` substitution.

Invoke it from `finalize` after asset upload:

```bash
bun scripts/rollover-changelog.ts "$VERSION" "$PUBLISHED_AT"
```

Update the existing commit step from `git add package.json` to `git add package.json CHANGELOG.md`, retaining the existing bot identity and push.

- [ ] **Step 3: Review workflow expressions**

Confirm the workflow uses the release event values only in `finalize`, while the manual-dispatch build still passes its computed version to the generator and continues uploading both files at lines 143-148.

- [ ] **Step 4: Commit the workflow changes**

Run:

```bash
git add .github/workflows/release.yml scripts/rollover-changelog.ts
 git commit -m "ci: finalize release changelog"
```

---

### Task 4: Run regression and release smoke verification

**Files:**
- Verify: `shared/changelog.ts`
- Verify: `scripts/generate-release-note.ts`
- Verify: `.github/workflows/release.yml`
- Verify: `test/changelog.test.ts`

- [ ] **Step 1: Run focused tests**

Run `bun test test/changelog.test.ts --timeout 30000`. Expected: all changelog parser, rendering, rollover, date-formatting, and CI-check tests pass.

- [ ] **Step 2: Run generator smoke verification**

Run:

```bash
bun scripts/generate-release-note.ts 9.8.7 2026-08-05T23:30:00-07:00
```

Verify `releasenotes.md` begins exactly with `## v9.8.7 - 2026-08-06`, `releasenote.md` has no `### Internal`, and released headings follow in source order.

- [ ] **Step 3: Verify rollover output without mutating tracked changelog**

Run a Bun one-liner or focused test against a fixture containing `Unreleased`; assert the result begins with empty `Features`, `Fixes`, and `Internal`, followed by `## v9.8.7 - 2026-08-06`, and that the promoted section still contains its `Internal` entry.

- [ ] **Step 4: Inspect the final diff**

Confirm only the intended source, test, workflow, and committed plan/spec files changed; confirm both release assets remain listed in the workflow upload paths.
