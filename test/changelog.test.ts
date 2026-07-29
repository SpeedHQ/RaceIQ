import { describe, expect, test } from "bun:test";
import { parseChangelog, renderReleaseBody } from "../shared/changelog";

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
        notes: "### Breaking\n- Database migration\n\n### Features\n- New dashboard",
        breaking: true,
      },
    ]);
  });

  test("renders a release body with Breaking first and no Internal section", () => {
    expect(renderReleaseBody(`
### Features
- New dashboard

### Internal
- Refactor parser

### Breaking
- Migration required
`)).toBe("### Breaking\n- Migration required\n\n### Features\n- New dashboard");
  });
});
