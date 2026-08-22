# Quality Scripts

Capture and compare quality/performance measurements and exercise update installation.

| Command                                                                                                      | Purpose                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `bun scripts/quality/ai-baseline.ts`                                                                         | Run AI evaluation fixtures and write a SHA/model baseline under `test/ai-fixtures/baselines`. Requires Gemini API credentials. |
| `bun scripts/quality/bench-compare.ts <baseline.json> <current.json> [--threshold=5] [--fail-on-regression]` | Emit benchmark markdown diff; optionally fail when regressions exceed threshold.                                               |
| `bun scripts/quality/test-updater.ts`                                                                        | Build/reuse local installer and start dev server with forced-update variables.                                                 |

Inputs: AI credentials and fixtures, Mitata JSON result files, or local package/installer state. Outputs: baseline JSON, markdown on stdout, or update-test process logs/status.

Boundary: measurement and local verification workflows only. Scripts do not own production builds, test fixtures, benchmark generation, or release publication.

Focused verification: run benchmark comparison with representative JSON pairs and threshold/failure flags; run AI baseline only with configured credentials; run updater with Inno Setup available.
