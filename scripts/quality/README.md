# Quality Scripts

Capture and compare quality/performance measurements and exercise update installation.

| Command                                                                                                                                                                                                          | Purpose                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `bun scripts/quality/ai-baseline.ts`                                                                                                                                                                             | Run AI evaluation fixtures and write a SHA/model baseline under `test/ai-fixtures/baselines`. Requires Gemini API credentials. |
| `bun scripts/quality/bench-compare.ts <base-1.json> <current-1.json> ... [--median-threshold=10] [--retained-heap-threshold=10] [--max-cpu-error=3] [--max-retained-heap-error=5] [--bootstrap-samples=10000] [--title=<heading>] [--fail-on-regression]` | Compare schema-versioned paired replay reports with deterministic hierarchical confidence intervals. |
| `bun scripts/quality/run-bench-ci.ts --base=<path> --current=<path> --reports=<path>` | Run local/CI counterbalanced replay benchmark rounds and write paired JSON/Markdown artifacts. |
| `bun run bench:replay-io [--output=<path>]`                                                                                                                                                                      | Run isolated end-to-end replay I/O benchmark with temporary SQLite state and report Mitata samples.                            |
| `bun scripts/quality/test-updater.ts`                                                                                                                                                                            | Build/reuse local installer and start dev server with forced-update variables.                                                 |

Inputs: AI credentials and fixtures, same-machine Mitata JSON result files, two RaceIQ checkouts for counterbalanced replay runs, or local package/installer state. Outputs: baseline JSON, paired benchmark JSON/Markdown, markdown on stdout, or update-test process logs/status.

Boundary: measurement and local verification workflows only. Scripts do not own production builds, test fixtures, benchmark generation, or release publication.

Focused verification: run benchmark comparison with representative JSON pairs and threshold/failure flags; run AI baseline only with configured credentials; run updater with Inno Setup available.
