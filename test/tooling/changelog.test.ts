import { describe, expect, test } from "bun:test";
import {
  formatReleaseDate,
  parseChangelog,
  renderAllReleaseNotes,
  renderReleaseBody,
  renderUnreleasedBody,
  rolloverChangelog,
} from "@shared/tooling/render";
import { hasUnreleasedChangelogChange } from "@shared/tooling/validation";
describe("changelog parser", () => {
  test("parses releases and strips Internal from rendered notes", () => {
    const entries = parseChangelog(`
## Unreleased

### Features
- Future feature

## v1.2.0 - 2026-07-01

### Breaking
- Database migration

### Features
- New dashboard

### Internal
- Refactor parser
`);

    expect(entries).toEqual([
      {
        version: "1.2.0",
        date: "2026-07-01",
        notes:
          "### Breaking\n- Database migration\n\n### Features\n- New dashboard",
        breaking: true,
      },
    ]);
  });

  test("renders a release body with Breaking first and no Internal section", () => {
    expect(
      renderReleaseBody(`
### Features
- New dashboard

### Internal
- Refactor parser

### Breaking
- Migration required
`),
    ).toBe(
      "### Breaking\n- Migration required\n\n### Features\n- New dashboard",
    );
  });
  test("renders the Unreleased section for the release artifact", () => {
    expect(
      renderUnreleasedBody(`## Unreleased

### Features
- New feature

### Internal
- Build detail

## v0.13.0 - 2026-07-16
`),
    ).toBe("### Features\n- New feature");
  });
  test("renders all public release notes without Internal sections", () => {
    expect(
      renderAllReleaseNotes(`## Unreleased

### Features
- New feature

### Internal
- Build detail

## v0.13.0 - 2026-07-16

### Fixes
- Old fix

### Internal
- Old detail
`),
    ).toBe(
      "## Unreleased\n\n### Features\n- New feature\n\n## v0.13.0 - 2026-07-16\n\n### Fixes\n- Old fix",
    );
  });
  test("renders the requested release heading before existing history", () => {
    expect(
      renderAllReleaseNotes(
        `
## Unreleased

### Features
- New feature

### Internal
- Refactor

## v0.13.0 - 2026-07-16

### Fixes
- Old fix

## v0.12.0 - 2026-06-01

### Features
- Older feature

### Internal
- Older detail
`,
        { version: "0.14.0", date: "2026-08-05" },
      ),
    ).toBe(
      "## v0.14.0 - 2026-08-05\n\n### Features\n- New feature\n\n## v0.13.0 - 2026-07-16\n\n### Fixes\n- Old fix\n\n## v0.12.0 - 2026-06-01\n\n### Features\n- Older feature",
    );
  });

  test("rolls the released Unreleased block forward", () => {
    expect(
      rolloverChangelog(
        `
## Unreleased

### Features
- New feature

### Internal
- Refactor

## v0.13.0 - 2026-07-16

### Fixes
- Old fix
`,
        { version: "0.14.0", date: "2026-08-05" },
      ),
    ).toBe(`## Unreleased

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

  test("formats a publication timestamp as a UTC ISO date", () => {
    expect(formatReleaseDate("2026-08-05T23:30:00-07:00")).toBe("2026-08-06");
  });

  test("rejects an invalid publication timestamp", () => {
    expect(() => formatReleaseDate("not-a-date")).toThrow(
      "Invalid release date",
    );
  });
});


describe("changelog CI check", () => {
  test("accepts an added bullet under Unreleased", () => {
    expect(
      hasUnreleasedChangelogChange(
        [
          "@@ -1,2 +1,5 @@",
          " ## Unreleased",
          " ",
          " ### Features",
          "+- New feature",
        ].join("\n"),
      ),
    ).toBe(true);
  });
  test("accepts an added bullet when Unreleased is outside the diff hunk", () => {
    expect(
      hasUnreleasedChangelogChange(
        [
          "@@ -11,3 +11,4 @@",
          " ### Internal",
          "+- Consolidated per-game routes",
          " ",
          "## v0.13.0 - 2026-07-16",
        ].join("\n"),
        `## Unreleased

### Internal
- Existing note

## v0.13.0 - 2026-07-16`,
        `## Unreleased

### Internal
- Existing note
- Consolidated per-game routes

## v0.13.0 - 2026-07-16`,
      ),
    ).toBe(true);
  });

  test("rejects a changelog change outside Unreleased", () => {
    expect(
      hasUnreleasedChangelogChange(
        [
          "@@ -8,2 +8,3 @@",
          " ## v0.13.0 - 2026-07-16",
          " ",
          "+- Backfilled note",
        ].join("\n"),
      ),
    ).toBe(false);
  });
});
