# macOS desktop, F1 2026 telemetry, and Codex AI goal

## Active goal — 2026-10-30

Deliver an Apple Silicon RaceIQ macOS `.app` using Tauri and a bundled Bun
backend, supporting F1 25's 2026 Season Pack UDP format alongside existing
2025 telemetry, with Codex available for lap/comparison analysis, AI chat,
and the setup engineer through ChatGPT sign-in without an OpenAI API key.
Make response budgets configurable and measure response quality, completion,
latency and actual token use before choosing production defaults.

Completion requires all of the following:

1. The `.app` launches without a terminal or separately installed Bun/Node,
   receives UDP, displays live dashboards, records laps, opens Replay and
   Compare, preserves history after restart, and quits without orphan processes
   or damaged recordings. Native lifecycle verification is separate from
   Chromium/WebKit browser coverage.
2. The 2026 format is implemented from EA's current specification and verified
   against a real DLC recording. Both years pass UDP-to-browser, capture,
   import/export, lap timing, Replay and Compare regression checks. Unknown
   packet versions or unavailable channels never become plausible zero data.
3. A signed-in Codex account can produce schema-valid grounded lap/comparison
   analysis, stream and resume chat, and execute authorized setup-engineer
   tools. No API key is required for the Codex path; other providers still work.
4. Larger budgets work where supported, truncation is explicit, and a repeatable
   comparison of response quality versus token use is delivered. Longer answers
   alone do not establish better analysis.
5. Required repository checks and focused changed-behavior tests pass. Existing
   unrelated failures are documented separately; they must not be concealed by
   weakening the new acceptance gates. Deliver a local app artifact, reproducible
   build/run instructions, validation evidence, and coherent local commits.

Work on `codex/macos-tauri-e2e`. Preserve user data and existing game/provider
behavior. Push only to `dedeco-carrera/RaceIQ` if fork access is available;
never push upstream. Maintain milestone evidence and continue through ordinary
implementation choices. Request input for missing credentials/captures,
destructive migration choices, or material scope expansion. Exhaust safe
independent work while an external prerequisite is missing; never claim a
real-capture or authenticated integration gate passed without running it.

This document is the proposed shared contract for backend and UI implementation.
The user activated this goal from the attached copy on 2026-10-30. Provider,
DLC parser, token controls and native app remain implementation milestones.

## Baseline and scope

Fork branch: `codex/macos-tauri-e2e`. Upstream baseline: `SpeedHQ/RaceIQ`
`e429369be` (v0.20.0), synchronized on 2026-10-29. Keep upstream fetch-only;
publish this work only to `dedeco-carrera/RaceIQ` after fork access is available.

Use the `packageManager` version in the root manifest (currently Bun 1.4.3).
The older global Bun 1.3.14 is not the verification baseline.

First supported live source: F1 25 / 2026 Season Pack UDP from a console or Windows gaming machine
on the same network. macOS runs RaceIQ, not the Windows game. Windows shared
memory for ACC, AC Evo, iRacing and LMU cannot be read across the network;
support there requires an explicit Windows sender/bridge in a later milestone.
Saved recording import and browser dashboards remain useful independently.

## Shared desktop contract (proposed)

- Bun remains authoritative for UDP parsing, recording, SQLite, API and WebSocket
  transport. React keeps its existing same-origin Hono RPC and WS interfaces.
- Tauri owns the native window, app lifecycle and one supervised Bun sidecar.
  It starts the backend, waits for readiness, then opens its loopback URL.
- Desktop HTTP binds only to loopback. UDP binds to the selected network
  interface and configured telemetry port (5301 by default).
- The shell uses a private allocated HTTP port; it must never kill another
  RaceIQ instance to claim a port. Single-instance behavior needs an explicit
  policy. Backend crashes produce an actionable startup/restart state.
- macOS data lives under `~/Library/Application Support/RaceIQ`; logs and
  recordings remain outside the signed, read-only `.app`. Existing data must
  be detected and migrated without overwriting either location.
- Closing/quitting the app flushes recordings and stops its own sidecar and
  workers. No orphan backend or sleep-prevention process may remain.
- Rust owns native privileges; the loaded page receives no generic shell
  execution capability. Keep current dashboard authentication; do not treat
  loopback or a WebView as authentication.
- Bundle the compiled Bun backend, its workers, catalogs/static assets and
  platform-specific native addons. Installed apps must not need Bun, Node,
  Homebrew or repository paths on PATH.
- Desktop builds disable the Windows binary updater. Signing/notarization and
  a fork-owned Tauri update feed are separate release work.

This contract must be finalized before UI and backend implementation diverge.
Both implementation tracks below depend on it.

## Shared telemetry and AI contract (proposed)

- Preserve existing 2025 captures, routes and persisted identities. Both DLC
  output formats use the existing `f1-2025` installed-game adapter; wire format
  and car regulations remain independent. Do not rename history or infer car/
  track identities from protocol year. See the [wire audit](f1-2026-wire-audit.md)
  for pinned source, decoder matrix and backend/UI semantics.
- Keep telemetry semantics one-to-one with EA output. Audit changed packet
  lengths, grid capacities, events, car/track catalogs and energy/aero channels.
  Never relabel 2026 concepts as legacy DRS/ERS without source evidence.
- Codex is a distinct provider, not an OpenAI-compatible endpoint supplied with
  copied subscription tokens. Prefer a backend-supervised `codex app-server`
  integration for sign-in, model discovery, streaming and RaceIQ tool calls.
  Verify actual supported protocol capabilities against the installed version.
- Existing authenticated Codex CLI may be an explicit dependency of this first
  local release. Find it reliably from a GUI launch, allow executable selection,
  and show missing-install/login guidance. Self-contained Codex redistribution
  is separate follow-up work; Bun/Node must still be bundled.
- Account access and quotas remain Codex-managed. Do not read, copy or log auth
  tokens, change the user's global Codex configuration, or silently fall back
  to a billable API-key provider. Keep model selection account-capability based.
- Analysis and chat receive read-only telemetry tools. The Race Engineer alone
  gets `apply_changes`; Driver Coach alone gets `record_drill`. Preserve focus
  switching, canonical history, persistence and retry semantics. Expose only
  explicit RaceIQ tools; no general filesystem, terminal or network privileges.
- All setup writes pass existing domain validation and user-action rules.
  Cancellation, retries or stream reconnects must not apply a change twice.
- Requests carry provider/model, operation, response budget and supported
  reasoning effort. Results preserve structured analysis or streamed text/tool
  events, completion status and available usage. Missing metrics are unknown,
  not zero; subscription usage must not be shown as invented dollar cost.
- Store per-feature budgets for analysis, comparison, chat and setup engineer.
  Initial experimental default: 32,768 output tokens where supported; advanced
  experiments: 16,384 / 32,768 / 65,536, bounded by verified model/provider limits.
  These are ceilings, not response-length targets. Audit every nested analyst,
  tool/structuring pass, summarizer and existing hard-coded cap.
- Separate visible output allowance from reasoning effort, context capacity,
  tool-step limits and timeouts. If Codex exposes no supported output-cap knob,
  show that constraint, use its supported model/runtime allowance, and measure
  actual output instead of pretending an API `max_output_tokens` was applied.
- Instrument requested/effective budget, input/cache/output and reasoning counts
  when reported, provider/model/runtime/prompt version, time to first content,
  total latency, tool calls, retries and finish/truncation reason. Cache identity
  must account for generation settings so budget comparisons use fresh runs.

## Execution order and prerequisites

Keep the existing F1 2025 gate green. First audit EA's latest DLC specification,
the removed Codex provider and its settings migrations (upstream `cb617705a`,
`68794f96a`, `2ce655163`), and current Codex protocol support. Review history for
lessons; do not restore removed code wholesale.

Then complete the native host, the DLC decoder/fixtures, and a single real Codex
lap-analysis request before expanding Codex to chat and engineering. Finish with
budget experiments and the combined native-app acceptance run. Dependencies and
evidence live here, with separate backend/UI implementation plans below.

## Milestone 1: real UDP browser gate

Run from `playwright/`:

```sh
bunx playwright install chromium webkit
# First run `bun run build:browser` from the repository root.
bunx playwright test --config=udp.config.ts --project=udp-chromium
bunx playwright test --config=udp.config.ts --project=udp-webkit
```

The suite uses a dedicated unseeded server, disposable `test-data-udp`, HTTP
3132, Vite 4132 and UDP 15332. It replays the committed real F1 25 wire capture
through a UDP socket; no API/WS telemetry injection or prepopulated laps.
Assertions cover live timing, pit view navigation, changing raw speed,
navigation from captured session laps into Replay, Compare and raw export/import.
Both browsers now also run a clearly labeled specification-derived 2026 stream,
checking changing aero readings and preservation of new channels in saved data.
Failure traces/screenshots
stay under ignored `playwright/test-results/udp`.
Compiled mode is the default; `E2E_SERVER_MODE=dev` selects Bun/Vite diagnostics.

Acceptance: both browser engines pass on macOS, then the same behavior passes
against a compiled backend. WebKit browser coverage does not prove native
Tauri lifecycle, entitlements or WKWebView behavior.

Local baseline checks: the Apple Silicon compiled build, root `bun run typecheck`,
repository lint, focused UDP typecheck and changelog tests pass with Bun 1.4.3.
The real-UDP acceptance scenario passes against the compiled backend in both
Chromium and WebKit on macOS. Each run sends 197,511 datagrams and captures
saved laps; listener diagnostics reported zero malformed drops in the baseline.
The expanded gate pins native lap timings; lap 4 is 86.709 s, while a later
90.704 s update belongs to the subsequent lap despite its unchanged lap number.
The full two-format expanded scenarios pass Chromium and WebKit. The combined
run's saved result reports passed with no failed tests. Internal Live/Raw/Sessions
navigation uses existing controls; the F1 dashboard shares both Live URL variants.
The wider `playwright/tsconfig.json` check separately reports 22 existing errors
in LMU/session E2E files; the focused UDP check excludes those unrelated specs.

## Milestone 2: backend implementation plan

Implemented foundation: `RACEIQ_DESKTOP=1` requires explicit absolute storage,
uses an OS-allocated loopback HTTP port, never clears another listener, suppresses
browser/tray/sleep-prevention launch, disables the Windows updater and publishes
versioned readiness JSON. Focused subprocess tests verify startup, settings
persistence over restart, graceful exit and occupied-port ownership.
The new native host is under `apps/desktop`; packaging/native acceptance and
legacy-data migration remain open until backed by runtime evidence.

Native foundation evidence (2026-10-30): `bun run desktop:build` produced an
ad-hoc-signed 449 MiB app after disabling symbol stripping for this macOS Rust
toolchain and adding a generated ICNS icon. `codesign --verify --deep --strict`
passes. The packaged app rendered the existing onboarding screen in WKWebView
from its bundled backend at an allocated loopback port. Native Cmd+Q returned
exit code 0 and the former backend listener closed. Isolated smoke data lives
under ignored `data/native-smoke`; no password/setup choices were changed.
UDP 5301 was occupied by the running dev preview, so this native launch does
not establish native recording acceptance. The rebuilt compiled backend's
Chromium real-UDP gate passes separately. Rust URL validation and 10 focused
backend/runtime tests pass, as do root typecheck, lint and changelog tests.

Depends on milestone 1 and the shared contract above.

1. Verify `bun run build` on Apple Silicon; smoke-test compiled startup, data
   persistence and UDP capture outside the repo. Inventory native addon and
   worker resources using the current build output.
2. Introduce explicit desktop runtime options: loopback binding, allocated
   HTTP port, data directory, no browser launch/tray/Windows updater, and
   readiness signaling. Keep CLI/server behavior explicit and compatible.
3. Replace any port-clearing behavior in desktop mode with bind failure or
   allocation. Test startup collision and source bind failures.
4. Add macOS data-directory resolution and safe legacy migration; test paths
   containing spaces, read-only bundles, restarts and existing databases.
5. Exercise graceful shutdown during capture and worker processing. Require
   a fully readable saved capture after app exit and no remaining processes.

Acceptance: compiled sidecar starts from app-like resource layout without
external runtime installs; repeated start/stop preserves settings and laps.

## Milestone 3: native/UI implementation plan

Depends on milestone 2 and the same shared contract above.

1. Add a small Tauri 2 workspace with a Rust-owned sidecar supervisor and
   bundled resources. Use target-specific sidecar names for arm64 and x64.
2. Add a native startup window and readiness/error handoff to the existing
   React application. Keep server-state logic in Bun.
3. Add macOS menu, quit, file-open/import and external-link behavior; verify
   keyboard navigation, title bar, resizing and Retina layouts in WKWebView.
4. Add native lifecycle smoke coverage separately from the UDP browser suite.
   Verify available Tauri WebDriver tooling on macOS rather than assuming
   Playwright controls WKWebView.

Acceptance: a local `.app` launches by double-click, records F1 UDP, opens a
saved lap, restarts with history intact, and exits cleanly without a terminal.

## Milestone 4: F1 2026 Season Pack support

Experimental parser foundation implemented 2026-10-30. The
[wire audit](f1-2026-wire-audit.md) pins the downloaded EA structures attachment
and the cross-checked Season 8 version 1.2 PDF. Eight specification-derived
parser/storage tests cover 24-car layouts, new energy/aero channels, checkpoint
parity, mixed-format resets and malformed input. The first real 2026 relay capture
was saved privately on 2026-10-31: 47,789 datagrams, strict framing validation,
45,118 decoded snapshots, no parser exceptions or observed supported-size
mismatches. It records a Mercedes 2026 time trial at Mexico and a native 79.588 s
lap reading, but begins 1.919 s into that lap. Full-lap real-capture acceptance
therefore remains pending. See the wire audit for its hash and limitations.
Raw now resolves game-specific extensions through the catalog source inventory,
so new fields carry units/categories/provenance without changing UI components
or styling. The 2025 and synthetic 2026 UDP-to-Replay/Compare/export/import
scenarios pass Chromium and WebKit. Season catalogs,
dedicated Live/Replay channel presentation, real-DLC and native acceptance remain
pending.

Backend plan, against the shared telemetry contract above:

1. Pin EA specification revision and source hash; document the 2025/2026 wire
   diff and supported packet-version matrix before implementing layouts.
2. Add versioned parsing, strict bounds checks and season-aware catalog/semantic
   mappings. Cover truncated/unknown packets, session resets, player/grid
   selection, lap/sector timing and capture checkpoint/reprocessing behavior.
3. Extend UDP browser tests with specification-derived fixtures, then a real DLC
   recording. Label synthetic and real evidence separately. Preserve 2025 tests.

UI plan, against the same shared telemetry contract:

1. Identify the DLC/season and explain the in-game UDP format selection.
2. Surface verified new/changed channels and honest unavailable states in Live,
   Raw, Replay, Compare and AI context without duplicating server calculations.
3. Update translated setup/help copy and validate both years in Chromium,
   WebKit and the native app.

Acceptance: a real 2026 capture passes the same end-to-end path as 2025, with
reviewed expected timing/channel values. If no real capture is available,
synthetic tests may prove implementation progress but not this milestone done.

## Milestone 5: Codex provider and response-budget controls

Protocol audit (2026-10-30): installed Codex CLI is 0.164.0 and reports ChatGPT
sign-in. Its locally generated experimental schemas expose `dynamicTools` on
`thread/start`, and `outputSchema`/reasoning `effort` on `turn/start`; neither
request has an output-token ceiling field. Do not fabricate a Codex output cap.
[Official app-server documentation](https://learn.chatgpt.com/docs/app-server)
supports the managed-login path for local/open-source applications; this goal
does not authorize extracting its tokens or turning it into a hosted service.
[The newer sign-in route](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
also warns that `model/list` may be a bundled catalog, not an entitlement check.
Actual inference must prove access. Before sending lap data, verify that the
child runtime exposes only allowed RaceIQ tools, without inherited shell,
filesystem, MCP/app or agent privileges. Generated schema inspection is not an
authenticated analysis/tool-isolation smoke test; those gates remain pending.

Backend plan, against the shared AI contract above:

1. Audit prior provider removal and repair the migration that currently clears
   persisted `codex` selections. Prototype supported ChatGPT-authenticated
   app-server login/status, model discovery, one schema-valid lap response,
   streaming, cancellation and controlled shutdown.
2. Implement the provider boundary through all relevant Mastra/direct-generation
   paths, including comparison, nested analyst consultation, chat history,
   setup engineer tools and focus-driven coach handover. Keep current providers.
3. Centralize response budgets and capability validation, report unsupported
   controls, handle incomplete/invalid output explicitly, and persist diagnostics
   without credentials or unnecessary raw private telemetry.
4. Add mocked protocol tests for missing binary/login, quotas, incompatible
   versions, malformed output, stream interruption and duplicate tool delivery.
   Follow with authenticated smoke tests; mocks do not establish sign-in works.

UI plan, against the same shared AI contract:

1. Add Codex provider/model/status selection and explicit connect/login flow.
   Request no API key for this provider. Keep credentials in the Codex runtime.
2. Reuse existing analysis/chat/engineer UI for streaming, history, tools,
   cancellation and recovery. Present quota/login failures without losing work.
3. Add translated per-feature response-budget and supported reasoning controls,
   with requested/effective limits, usage, latency and truncation diagnostics.
4. Verify provider switching and persistence after app restart plus both `car`
   and `driver` experiment focus. Do not let either role acquire the other's tools.

Acceptance: the packaged app can use the configured Codex installation and
ChatGPT account to analyze a saved lap, compare laps, continue a saved chat and
complete one authorized setup change without an OpenAI API key. Changes persist
once; cancellation and reconnect preserve history and domain state.

## Milestone 6: response-quality experiments and combined acceptance

Use representative known laps for both years, a comparison with known faster
lap, a multi-turn chat and a setup-engineer scenario with expected tool behavior.
Run a bounded initial matrix at the three budget ceilings where supported,
with three repetitions per case/configuration. Keep model, data and prompt
revision fixed; vary reasoning separately. For unsupported Codex output caps,
report measured runs under its supported controls instead of fabricating a sweep.

Compare schema validity, corner coverage, numeric grounding, units, faster-lap
direction, actionable advice, tool correctness, truncation, usage and latency.
Retain existing scorer thresholds; add explicit DLC-specific signals. Record
human-review examples for relevance and clarity. Save redacted diagnostics and
a report recommending per-feature defaults, including unsuccessful runs.

Acceptance: required checks and the two-year UDP browser gates pass; native
launch/record/replay/restart/quit passes; authenticated Codex analysis/chat/setup
works; the report explains whether larger outputs helped and what each feature
actually consumed. Quota-exhausted or unavailable-auth runs remain unverified.

## Later: distribution (outside the first goal)

Build on native arm64 and x64 runners, sign nested binaries/addons and the app,
notarize, and test quarantine/Gatekeeper on a clean Mac. Publish only through
the fork. Apple signing credentials and a release/update policy are required
before distributing signed builds.
Intel builds, public releases, Windows shared-memory forwarding and unrelated
game additions are also outside the first goal.

## Upstream references

- [Tauri external binaries](https://v2.tauri.app/develop/sidecar/)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri test support](https://v2.tauri.app/develop/tests/)
- [EA F1 25 / 2026 Season Pack UDP specifications](https://forums.ea.com/blog/f1-games-game-info-hub-en/ea-sports%E2%84%A2-f1%C2%AE25-2026-season-pack-udp-specification/12187347)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
