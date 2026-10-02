# Test fixtures

`test/fixtures/` stores small, committed, deterministic inputs and golden files
that make ordinary tests repeatable. Treat these files as immutable test data:
change them only when behavior or a reviewed expected result intentionally
changes.

Current fixture set includes `track-guide-context.golden.json`. Add new data under
this directory only when it is a general test fixture, not a generated capture.
Keep domain-specific fixtures close to their owning suite when that is clearer,
and use `test/ai-fixtures/` for curated model-evaluation inputs.

## Fixtures versus artifacts

- **Fixtures:** committed inputs or expected outputs consumed by tests. They are
  stable, reviewable, and deterministic.
- **Artifacts:** generated reports, SVGs, logs, captured recordings, benchmark
  output, or other run products. Keep them under `test/artifacts/` or the
  documented E2E output path; do not move them into `test/fixtures/` or claim
  artifacts moved during test-suite reorganization.

Large binary recordings remain in `test/artifacts/` and are not ordinary
fixtures. AI packet ZIPs and score snapshots remain in their existing
`test/ai-fixtures/` subdirectories.

## Adding a fixture

1. Confirm test needs immutable input or expected output rather than a generated
   artifact.
2. Put it under the owning fixture directory and use stable, descriptive names.
3. Keep fixture loading and assertions in the owning domain or matching
   `test/support/<domain>/` support module.
4. Run the focused test, then standard suite when the fixture contract is ready.

Prefer splitting test files near 400 lines when a real behavior seam appears.
This is guidance for maintainability, not a blind line-count rule; keep cohesive
fixture cases together.
