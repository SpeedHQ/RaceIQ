# macOS desktop, F1 2026 telemetry, and Codex AI goal

Installed telemetry testing build: `0.20.0-private.20261031.1`, with local tag
`private/macos-2026-10-31.1` not published. The next local build is
`0.20.0-private.20261031.2`, adding AI settings. Build with
`bun run desktop:build`; install the resulting `RaceIQ.app` in `/Applications`.
Native data remains in `~/Library/Application Support/RaceIQ`; this test
installation uses UDP port 20778 for the existing SimHub relay. No public
GitHub release is created. Codex UI/chat/setup and combined acceptance remain
in progress; this is a telemetry testing checkpoint, not goal completion.

## AI settings checkpoint — 2026-10-31

The [AI settings contract](../architecture/ai-settings-contract.md) defines the
separate backend and UI plans for editable lap/comparison guidance and Codex
discovery. Both prompt editors save through the authenticated settings API,
support reset to shipped defaults and retain drafts after failed saves. Effective
instructions participate in the stored analysis generation identity with model,
provider, reasoning, budget, units and language. Migration 84 preserves old
analyses; unversioned results need regeneration rather than deletion.

Codex account/model discovery passed against the installed CLI without inference.
Settings can select its verified model for lap/comparison analysis without an API
key; every generation still revalidates managed authentication and isolation.
Chat/setup selection remains unavailable until their bridges are implemented.
Chromium settings coverage passed edit/save/reopen/reset, failed-save retention,
Codex model selection and existing API-provider controls (four scenarios).
These are local source changes, not yet installed into the running native app.
Native verification and the full response-quality matrix remain separate gates.

The `.2` artifact has now been built and its ad-hoc signature verified. Its
bundled backend passed two launches with `/usr/bin:/bin` as PATH, using disposable
data: saved prompt/provider/model preferences survived restart, managed Codex
discovery returned the verified model, and each backend exited cleanly. npm's
Node launcher initially failed this check; executable discovery now reads its
public package metadata and launches the installed native Codex binary directly.
No dependency source, credentials, global configuration or shell startup files
are read or changed. The standalone install location `~/.local/bin/codex` is
also discovered. Installed user app remains `.1` pending a safe garage point.

WebKit also passed prompt save/reopen/reset/failed-save retention, Codex model
selection and provider selection. The fourth, existing API-error recovery test
still fails its console-error gate on a startup WebSocket "closed before the
connection is established" message. This is recorded separately, not filtered
out or claimed green. Its ambiguous multi-section text locator was corrected.
Desktop lifecycle source tests passed allocated-port/persistence/clean-exit and
busy-port ownership checks with loopback socket access; the restricted run could
not bind an ephemeral socket. Full native window/capture acceptance remains open.

The real Codex comparison endpoint also passed on two valid laps from the
committed public 2025 Lusail fixture (86.709s versus 90.704s). It returned
schema-valid output correctly identifying A as approximately four seconds
faster: 20,056 input / 3,465 output / 219 reasoning tokens, 58.5s provider wall
time, 10.9s first content. Cost remains unknown; requested 8,192 output tokens
is unsupported, with no fabricated effective cap. Same-settings cache reuse
and changed-instructions cache miss passed against the actual route. This is
one authenticated smoke run, not the response-quality matrix or native proof.
Local private artifact: `/private/tmp/raceiq-codex-app.8C5GDZ/app-comparison-result.json`.

Repository privacy remains unresolved: GitHub rejected changing a public fork
to private. No further public pushes or tag publication are authorized while the
standalone-private-repository versus support-assisted-detachment choice is pending.

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

Fork created 2026-10-31: [dedeco-carrera/RaceIQ](https://github.com/dedeco-carrera/RaceIQ).
The five implementation checkpoints through `63dc81d20` were pushed to
`codex/macos-tauri-e2e`; that branch now tracks the fork, while upstream push
remains disabled. A complete outgoing-object/history audit confirmed no private
relay capture was tracked or committed before publication.

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

### Codex provider binding contract

The provider ID is `codex`. `codexExecutable` is a persisted executable path,
not a shell command or argv; empty means trusted PATH/Homebrew discovery.
Browser settings reject executable-path writes; a native user-consented picker
must use the owned desktop control channel. Only backend-owned code constructs
CLI arguments. Codex never reads an API
key or falls back to another provider. The existing isolated runtime remains
mandatory. Generation returns nullable usage plus runtime/model, completion,
requested/effective budget, cached/reasoning tokens and latency diagnostics;
unsupported output caps remain explicitly unsupported.

Backend plan: preserve Codex selections in settings, bind the central resolver
to isolated text/structured generation, preserve diagnostics through analysis,
and test via an external CLI peer followed by authenticated app-path analysis.
UI plan, against this same contract: reuse provider/model pickers, add executable
selection and Codex-managed account guidance, then enable streaming/tools only
once their corresponding integration passes. A read-only generation checkpoint
does not complete chat, setup tools, budget controls or the overall goal.

Binding checkpoint (2026-10-31): a fresh disposable database imported the
committed `f1-2025-2026-04-09T21-34-10-190Z.bin.gz` recording. The in-process
Hono `POST /api/laps/3/analyse?regenerate=true` route analyzed its native-valid
87.316-second Lusail lap using the installed Codex CLI 0.164.0 and ChatGPT
account. Production output-schema validation passed, the analysis and unknown
cost round-tripped through SQLite, and run status became `finished`.
Measurements: 13,218 input, 0 cached input, 1,854 output, 173 reasoning output
tokens; runtime turn 41.160s, first runtime content 8.882s, provider wall time
42.610s. Requested output ceiling was the existing 8,192; effective ceiling
remained unknown/unsupported, not an applied cap. Experimental defaults and
budget controls are still pending.

Local evidence: `/private/tmp/raceiq-codex-app.8C5GDZ/app-analysis-result.json`
and its adjacent smoke script/log. Only the committed public fixture was used;
no private relay recording or credentials were copied. This proves the actual
analysis service, endpoint stream, central resolver and cache path—not native
WKWebView or provider-picker UI. Diagnostics currently travel on fresh results;
persisted diagnostic history remains pending. The newer AI settings checkpoint
above adds generation-settings cache identity and comparison routing; chat,
engineering and compaction integration remain pending.
The separate cache-only endpoint also returned the saved analysis with unknown
cost preserved, without invoking generation.

Shutdown ownership checkpoint: the application-owned Codex supervisor closes
admission synchronously, relays caller cancellation, aborts outstanding CLI
operations (including version/account preflight), and waits for their finalizers
before database write authority closes. Late completions racing shutdown are
cancelled instead of published. Repeated stop calls share the same drain.
A real backend subprocess using the production shutdown handler and provider
was tested with a disposable app-server peer that resists stdin EOF: before
the fix the backend exited with that peer still alive; after the fix shutdown
waits for termination/reaping. This is backend lifecycle evidence, not the full
native WKWebView quit/capture acceptance. The installed live-testing app was
not stopped or replaced.
Verification: 144 focused provider, settings, analysis and driver-profile tests
pass, including rejection of browser executable-path writes and Codex API-key
storage. Root lint/typecheck, 486-file shard registration and 11 changelog tests
pass with Bun 1.4.3. Provider-picker UI intentionally stays disabled for Codex
until account/model discovery and native ownership are wired.

### Analysis usage contract

Backend and UI share this contract when binding Codex to analysis: input/output
token counts, cost in USD and duration in milliseconds are `number | null`.
Null means unreported; numeric zero remains a real zero. Cache writes and reads
must preserve that distinction. Existing saved values and analysis identities
remain unchanged by the appended migration. UI renders unavailable metrics
without a fabricated zero or dollar amount. High-level callers may supply a
measured elapsed duration when the provider does not report one.

Backend plan: widen the shared usage contract, append a lossless migration for
lap/comparison caches and driver-profile caches/history, and preserve nullable
metrics through provider adapters, analysis normalization and tool output.
Acceptance: unknown/zero/known usage
round-trips through cache APIs and an upgraded historical database, including
saved profile plans, run errors/timestamps and deleted-ID high-water marks.

UI plan: consume the same nullable usage shape in the existing analysis footer;
retain layout and controls, format unavailable values explicitly, and verify
known, zero and unknown cases. Both plans depend on this usage contract, not
separate backend/UI interpretations.

Usage checkpoint (2026-10-31): the shared nullable contract, migration v83,
provider/analysis normalization, cache APIs, tool output and existing analysis
footer are implemented. Historical-upgrade tests preserve all four tables,
saved values, scope uniqueness, run constraints and deleted-ID high-water marks;
legacy saved zeros are not reinterpreted. Chromium and WebKit rendered the
unreported-usage Storybook fixture with zero page errors and enabled
Regenerate/Clear controls. This is formatting coverage, not authenticated
in-app Codex or native-app acceptance. Codex provider binding remains next.
Verification: 148 focused usage, driver-profile and Codex transport/runtime
tests plus 11 changelog tests pass; root lint, typecheck and test-shard
validation pass with Bun 1.4.3. Older migration sets reject schema v83, so
downgrading requires a compatible pre-upgrade database rather than opening
new nullable history with an older build.

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
The user chose to continue with this existing capture on 2026-10-31; do not wait
for another drive before independent implementation and partial-capture checks.
Raw now resolves game-specific extensions through the catalog source inventory,
so new fields carry units/categories/provenance without changing UI components
or styling. The 2025 and synthetic 2026 UDP-to-Replay/Compare/export/import
scenarios pass Chromium and WebKit. Season catalogs now include all 22 new
2026 F1/F2 team IDs, Madrid and the three reverse circuits, preserving existing
identities and leaving unverified track lengths/geometry unavailable. Dedicated
Live/Replay channel presentation, real-DLC and native acceptance remain pending.
AI context now distinguishes format from regulations and supplies native 2026
aero/overtake, ERS limits and session type with explicit missing-data boundaries;
real model quality and authenticated Codex acceptance remain unverified.
The native artifact was rebuilt on 2026-10-31;
strict deep signature verification passes and its bundled car/track CSVs are
byte-identical to the new source catalogs. This is build evidence, not native
capture/Replay acceptance.

The ERS/context checkpoint passes 42 F1 integration tests, including indexed
parity for both committed real 2025 recordings, and root typecheck. The rebuilt
compiled backend passes all four UDP browser scenarios (2025 real and 2026
synthetic, Chromium and WebKit) in 12.4 minutes. The compiled and packaged backend
SHA-256 matches: `e92e8da153a798d1d0380b921b994841804d40d9041a1c4b70c2a287b2eceb7d`.

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

Local transport preparation: the stdio connection can dispatch explicitly
registered dynamic tool requests without blocking other RPC replies. It still
rejects all server requests unless a tool handler is supplied, denies non-tool
requests, bounds and cancels in-flight work, and closes on duplicate RPC IDs.
The turn-scoped dispatcher validates the thread, turn, tool, role and arguments,
and deduplicates repeated tool call IDs for its lifetime. It is not yet wired
to chat or experiment agents. Reconnect-safe write idempotency and user-action
validation must be enforced by the experiment domain before enabling writes.

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
filesystem, MCP/app or agent privileges. Generated schema inspection alone is
not authenticated analysis or runtime tool-isolation evidence.

Local mock-provider probe (2026-10-31, CLI 0.164.0): a synthetic dynamic tool
successfully reaches the client and receives a fixed test result, without an
Authorization header to the mock. Process-only switches disable shell, image,
browser, apps, plugins, hooks and agent capabilities; configured MCP servers can
still appear in inventory with zero tools, so inventory names alone do not prove
exposure. Negative calls reject terminal/image tools and disable the code-mode
host, but an empty `apply_patch` initially still reached its built-in handler.
A temporary catalog exported from that exact CLI's bundled metadata, changing
only `apply_patch_tool_type` to `null`, makes the same patch call unsupported.
The account metadata cache was not reused because its client version is newer;
no auth file was read by the probe and no global configuration was changed. No files were changed
by the negative tool tests and no real inference or private telemetry was sent.
The process-only prototype is not a production provider or authenticated lap
analysis. An empty API `tools` array alone is insufficient: explicit positive
dynamic-tool routing and negative built-in dispatch tests are required.
With the patchless catalog, the permitted dynamic tool still reaches the client,
the actual thread's MCP tool inventory is empty, and terminal/image/patch calls
are unsupported while the code-mode host is disabled. This evidence is scoped
to the local mock and selected model, not a general compatibility or entitlement
claim.

Authenticated structured-analysis smoke (2026-10-31, CLI 0.164.0): the same
isolated runtime completed a real `gpt-6.1-sol` request through its built-in
OpenAI provider, after `account/read` confirmed ChatGPT-managed sign-in. The
test used only the committed public 2025 wire recording, not the private relay
capture: Lusail, F1 World, native lap 2 at 87.316 seconds, 31,399 decoded
samples, native validity flags and 15 committed curated corner regions.
The existing production prompt and analyst JSON schema were supplied, and the
result passed `AnalystModelOutputSchema`. The runtime reported completion,
five corner issues and two setup suggestions; the client observed zero tool
requests and zero excluded execution items. The thread's MCP tool inventory
was empty before inference. The managed child exited successfully afterward.

Measured from turn submission: first content 5.675 seconds; completion 47.592
seconds. Reported last-turn usage: 12,646 input tokens, zero cached input
tokens, 1,786 output tokens and 64 reasoning-output tokens. These are the
runtime's reported counters, not an invented output allowance or subscription
cost. Reasoning effort was `low`; no output cap was supplied because this
protocol has no supported output-ceiling field. Response and redacted diagnostics
remain local temporary artifacts; no credentials or private relay data were
copied. This establishes one authenticated, schema-valid response, not analysis
quality, chat/comparison/setup integration, cancellation, production provider
availability or compatibility with other CLI versions/models. The next gates
are the production provider boundary, role-scoped tool tests and quality checks.

In-repository transport foundation (2026-10-31): a private backend stdio
connection now handles request correlation, split UTF-8, notifications and
initialization notifications. It validates incoming envelopes, caps frames at
1 MiB by default and pending requests at 64, uses RPC deadlines and abort
signals, rejects every unsolicited server request, and stops dispatching after
closure. RPC/stream/shutdown failures expose fixed messages and numeric error
codes, not upstream payloads. No automatic retries are performed. Abort and
deadline close the transport; higher-level turn interruption and domain-safe
retry remain separate responsibilities.

Twenty-three focused cases pass against a local subprocess peer and injected
byte-stream/shutdown-failure boundaries. A separate real CLI metadata-only check used this
new connection for initialize/initialized/account-read, confirmed ChatGPT-managed
sign-in, and observed owned-child exit 0. No inference or private capture was
sent in that check. The earlier authenticated generation smoke remains distinct:
it used the temporary prototype, not this newly committed transport. Existing
providers/settings remain unchanged. At that checkpoint, CLI discovery, the
capability profile, generation, role-authorized tools, provider selection and UI
wiring were still pending; the transport alone is not an available app provider.

Guarded read-only generation is now implemented behind the backend boundary.
The initial verified profile requires CLI 0.164.0 and `gpt-6.1-sol`; other
versions/models fail closed until validated. A metadata-only child inventories
configured MCP names, then a separate child disables each discovered server.
Both check ChatGPT-managed sign-in and the excluded feature flags. The final
thread is ephemeral, read-only, approval-free and tool-free, using an isolated
temporary directory containing the version-matched patchless public model
catalog. Its actual MCP inventory must contain no tools or new server names
before telemetry is submitted. No auth file is read or copied by RaceIQ, global
configuration is unchanged, and API-key environment fallback is removed.

The runtime distinguishes final answers from partial/commentary output, rejects
failed/incomplete turns, isolates usage by turn, observes terminal EOF even after
RPC acknowledgement, and cancels account preflight as well as generation. Owned
children are closed with bounded termination escalation; generated temporary
catalogs are removed afterward. Missing token counts and subscription cost stay
unknown. Requested output budgets are retained in diagnostics with an explicit
unsupported/effective-null result, never sent as a fake Codex output ceiling.
Fourteen runtime cases and 24 transport cases pass against external CLI peers
and byte-stream boundaries. Provider/model settings, the existing Mastra paths,
streamed chat, role-authorized tools and UI wiring remain unchanged/pending.

A real public-fixture run through this in-repository runtime passed the existing
production analyst schema: the same 87.316-second Lusail/F1 World lap used above,
five corner issues and two setup suggestions. Measured from turn submission:
first content 5.542 seconds, completion 39.685 seconds; CLI-reported usage 12,628
input, zero cached input, 1,714 output and 97 reasoning-output tokens. Requested
budget 32,768 is correctly reported unsupported, effective ceiling unknown, cost
unknown. The private 2026 relay capture was not sent. This verifies authenticated
read-only generation through the new boundary, not model quality, in-app provider
availability, comparison/chat/engineer integration or combined native acceptance.
A repeat after the cancellation/final-answer checks also passed the production
schema: first content 4.486 seconds, completion 39.426 seconds; reported input
12,630, cached input zero, output 1,731 and reasoning-output 50 tokens. Both runs
used `low` effort and the same public lap/prompt. They are authenticated smoke
evidence, not the response-quality experiment matrix.

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
