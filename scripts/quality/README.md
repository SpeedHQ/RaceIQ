# Quality Scripts

Capture and compare quality/performance measurements and exercise update installation.

| Command                                                                                                                          | Purpose                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bun scripts/quality/ai-baseline.ts`                                                                                             | Run AI evaluation fixtures and write a SHA/model baseline under `test/ai-fixtures/baselines`. Requires Gemini API credentials.            |
| `bun scripts/quality/bench-compare.ts <baseline.json> <current.json> [--threshold=5] [--p99-threshold=5] [--fail-on-regression]` | Compare Mitata median, p99, and allocation results with separate steady-state and tail-latency tolerances; optionally fail on regression. |
| `bun run bench:replay-io [--output=<path>]`                                                                                      | Run isolated end-to-end replay I/O benchmark with temporary SQLite state and report Mitata samples.                                       |
| `bun scripts/quality/test-updater.ts`                                                                                            | Build/reuse local installer and start dev server with forced-update variables.                                                            |

Inputs: AI credentials and fixtures, same-machine Mitata JSON result files, or local package/installer state. Outputs: baseline JSON, markdown on stdout, or update-test process logs/status.

Boundary: measurement and local verification workflows only. Scripts do not own production builds, test fixtures, benchmark generation, or release publication.

Focused verification: run benchmark comparison with representative JSON pairs and threshold/failure flags; run AI baseline only with configured credentials; run updater with Inno Setup available.
