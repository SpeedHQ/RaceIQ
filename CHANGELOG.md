## Unreleased

### Features

- Run LMU setup and driving experiments with saved `.svm` bases, version review, car-and-track-matched lap history, and confirmed AI setup changes saved as new files without overwriting originals.
- Browse LMU game-folder or uploaded `.svm` setups, inspect the six in-game setup pages, and compare changed, added, and removed settings.
- Make explicit LMU click edits with capability-aware controls, linked corners, independent third elements, and an original-to-proposed preview. Save a new game-folder file or download without overwriting originals; stale sources and filename collisions retain pending edits.
- Consult attributed LMU community parameter and symptom guides. Saving or exporting setups requires acknowledgement that click ranges and physical values are unverified.
- Read offline, source-linked official LMU facts about hybrid power, battery charge, Virtual Energy, fuel planning, ABS maps, and traction control alongside separately labelled community setup advice.
- Ground LMU Analyse chat and experiment explanations in the bundled official and community setup knowledge through a read-only AI tool, with current-setup applicability and unchanged edit-confirmation rules.
- Read standalone, illustrated LMU setup guides at `/lmu/setups/guides` from the sidebar or Setups toolbar, with topic navigation and direct parameter links from comparisons. Guides do not depend on an active setup, and pending setup edits remain intact.
- Read front and rear ride height, springs, and anti-roll bar guidance together in one illustrated guide per topic instead of separate axle pages.
- Explore dimensional LMU guide animations with shaded components, moving airflow and racing paths, and side-by-side setting comparisons with matching explanations. No car drawings; pause motion or use reduced-motion diagrams.
- Use locale-backed LMU guide content with translated navigation and illustration labels in all supported languages; untranslated technical reference text falls back to English.
- See each saved setup's best valid lap and sort setups by lap time.
- Choose a track for ACC and AC Evo setups to see best laps recorded on that circuit.
- Search cars, tracks, and categories in ACC and AC Evo setup forms.
- Use keyboard-accessible controls to switch setup sections and sources.
- Edit setups through structured fields instead of Paste JSON, with a clearly labelled “Save Setup” action.
- Inspect uploaded setup contents from Import, show detected car information, then choose a destination track before saving; retain track assignments for imported AC Evo setups.

### Fixes

- Use consistent, readable font sizes across LMU setup guide navigation, explanations, links, and diagram captions on desktop and mobile.
- Read LMU setup guides with divider-led sections and clearly marked official facts; spring guidance uses front and rear cards below one softer/stiffer illustration pair.
- Compare isolated rear-wing and splitter mechanisms with downward load and setting-dependent airflow; distinguish toe, camber, caster, ride-height clearance, and braking-force diagrams.
- See steering front-wheel pairs follow LMU cornering symptom paths, with turn-in, oversteer countersteering, and exit unwind; pause and reduced-motion views preserve visible steering.
- Read axle-specific ride-height comparisons, side-profile wing and splitter diagrams, and differential wheel-speed coupling. Keep mechanisms visible when paused or using reduced motion, with readable stacked mobile comparisons and bumpstop engagement.
- Remove the community attribution footer from LMU guides while retaining the bundled license notice.
- Import LMU `.svm` originals into a selected existing game Settings folder, preserving exact bytes and listing them after reload. Existing files are protected; no browser-local setup persistence.
- Match the LMU setup browser to other games with a compact action toolbar, right-aligned filters, responsive ranked rows, and pagination.
- Use the shared import dialog for LMU `.svm` uploads, preserving the active setup on invalid files and confirming switches with pending edits.
- Select LMU setups with table checkboxes; show the Compare action only when exactly two setups are selected, including imported game-folder files.
- Keep fuel and Virtual Energy diagnosis available for non-hybrid cars; distinguish battery charge from stint allowances and correct extra-power and universal ABS-map claims using official LMU guidance.
- Reload changed LMU setup files on refresh while preserving pending edits until confirmed; keep simultaneous comparison loads and newer setup selections independent.
- Recognize LMU hybrid capabilities when setup headers omit class tokens, restrict rear-regeneration advice to LMDh cars, and mark impossible preset clicks unavailable.
- Stop opening a browser automatically during development launches; preserve first-run browser opening in installed builds.
- Warn before deleting a setup that is in use, list its linked sessions and laps, and preserve recordings when removing their setup associations.
- Keep Analyse Data vertically scrollable; restore borderless wheel metrics, right-align wheel headings, show the combined balance signal, and label pressure units once per row.
- Label the lap replay selector “Setup” and let users select “No setup” to unlink a saved setup from a lap.
- Hide setup lap times and lap-time sorting until a specific track is selected.
- Keep AC Evo setup editor actions visible while scrolling and remove excess left padding from the editor header.
- Restore AC Evo `.carsetup` imports from Sessions and the setup-file browser, with automatic car selection for uploaded setups that identify their car.
- Match AC Evo setup editing to the experiment setup viewer's tabs, corner cards, units, and ranges; preserve imported per-wheel details and saved edits.
- Keep unavailable per-car adjustments read-only in imported AC Evo setups.
- Refresh saved setup best laps and rankings when recordings or setup associations change.
- Align AC Evo setup inputs regardless of units, use compact controls without native number spinners, fill the available editor width, and arrange wheel sections side by side on desktop and stacked on mobile.
- Use searchable car, track, and category selectors in ACC and AC Evo setup forms.
- Use the application background instead of gray fill for shared text and numeric inputs.
- Keep local OpenAI-compatible lap analysis schema-valid, including required setup symptoms, while retaining tool-assisted analysis.
- Bundle official iRacing track maps for offline display without third-party browser requests.

### Internal
- Keep LMU guide illustration palettes in central theme tokens and use shared typography scales without changing diagram colors or mobile label sizes.
- Compose the exported backend RPC schema from named route schemas to avoid excessive compiler instantiation while preserving endpoint types and runtime routing.
- Publish generated translations without moving the output directory on Windows; retain validated caching, stale-module removal, and restoration of previous output on publication failure.
- Reload development clients only after translation publication completes; invalidate cached transforms instead of exposing partially updated message exports to the sidebar.
- Cover all five LMU setup classes with identity, targeted-edit, unavailable-control, and exact-byte restoration regressions; retain a byte-preserved, user-supplied Ginetta LMP3 export alongside explicitly synthetic Hypercar, LMP2, GT3, and GTE inputs.
- Separate backend core, capture formats, game implementations, and application composition into workspaces; colocate tests with their owners and isolate frontend contract tests from production dependency cycles.
- Colocate game-specific car images and track SVGs with their owning game packages while preserving public URLs, offline asset delivery, and shared catalog data.
- Run owner-scoped test processes with isolated databases and dependency-aware Turbo caches; select affected ordinary suites on pull requests with full-run fallback when SCM refs are unavailable.
- Scope external test inputs to their consuming owner suites and isolate test-only manifests and application support from production transit hashes.
- Split release, UI, build, catalog, data, and marketing utilities into responsibility-owned workspaces, preserving commands and test classifications while removing control-plane dependencies from runtime consumers.
- Isolate six browser-safe game metadata owners from shared contracts and server parsers; move cross-game catalog composition to its own workspace while preserving offline source and compiled catalog lookup.
- Extract browser-safe lap analysis and telemetry engines into dedicated core workspaces, preserving algorithm outputs, telemetry identities, suite classifications, and the separate Node projector boundary.
- Give dependency-free frontend conversion and lap-time helpers their own unit-test owner without weakening retained cross-layer frontend coverage.
- Isolate each workspace's TypeScript incremental cache and check projects sequentially without weakening the typed RPC contract.
- Include seeded route, import, and six-game capture-conversion projects in the default and compiled browser test gates.
- Serialize default browser test gates globally so capture migration cannot overlap other projects using the shared seeded database.
- Install workspace dependencies before CI changelog validation while retaining package imports.
- Stage checkout-local benchmark imports across the workspace layout migration without substituting current code for the base implementation.
- Retain Mars runner routing for pull-request build, test, browser, snapshot, and benchmark jobs.
- Remove game-file extraction tools and their settings UI.
- Use bundled ACC track SVGs for segment generation, visualization, and runtime centerlines; remove obsolete centerline CSVs and migrate saved segment and sector positions while preserving curated turns.
- Exclude generated JavaScript from client typechecking and emit Paraglide declarations in development so translation imports remain typed.
- Seed and validate the compiled E2E database once per workflow, then restore isolated database and capture copies in seeded shards instead of repeating fixture imports.
- Include LMU recordings and saved Analyse/Compare chat histories in shared Playwright seed artifacts; restore isolated chat-memory databases in each seeded shard.
- Remove redundant development database-seed tests from CI and verify recording imports after database upgrades.
- Prevent setup deletion from refetching usage data for a removed setup.
- Restore query context for setup browser snapshots, fail immediately on Storybook render errors, and show per-test snapshot progress in CI.
- Reduce snapshot memory churn by checking canvas stability inside the browser without PNG serialization and reusing screenshot dimensions during diff generation.
- Reuse validated Paraglide output and exact-key static Storybook builds in snapshot CI, separating compilation from capture while rejecting stale or damaged caches.
- Isolate Storybook cache Git operations from inherited hook variables so tooling tests cannot replace the caller's staging index.
- Install Node.js 22 in the CI test job so Storybook cache tooling tests use the required runtime instead of Bun's Node compatibility shim.
- Reuse compiled Paraglide output from the upstream build artifact in snapshot and compiled E2E jobs, with validated cache or compilation fallback.
- Run compiled E2E gates after build and test without waiting for snapshot comparison.
- Remove Storybook Docs generation and its addon from local previews and snapshot builds.
- Install workspace dependencies before release version computation and finalization, and keep dependency-install helpers free of workspace imports.
- Select telemetry-backed disposable import fixtures and allow long-running developer dump imports to finish in browser gates.

## v0.19.1 - 2026-10-01

### Features

- Add Spanish, Brazilian Portuguese, Japanese, Ukrainian, Dutch, Polish, Finnish, and Russian interfaces.
- Search track, car, language, and other option lists with accessible combobox controls.
- Slightly reduce corner radii through shared Tailwind tokens.
- Use accessible toggle groups for Sessions Mine/Others and Analyse tooltip display.
- Preview segments, sectors, and guide corners on the track map by hovering or focusing their reference rows or cards, highlighting the selected sections and hiding unrelated labels.
- Show session types for ACC and AC Evo in desktop session tables and mobile session cards.
- Expose ACC penalty codes, types, and time in telemetry, and list observed penalties on the race timeline without counting them as pit stops.

### Fixes
- Preserve LMU track map orientation when segment data loads, keeping segment overlays aligned with the initial map.
- Use common circuit definitions and guides for LMU tracks, aligning the map's lap origin with curated segment percentages instead of showing anonymous auto-detected turns.
- Show track facts and guides before slow map geometry loads, keeping reference data visible while the outline is loading.
- Show all 14 Barcelona 2025 turns as separate LMU segments, restoring T6 and T11 and using the correct no-chicane layout and guide.
- Restore missing official turns across ACC, AC Evo, F1 25, and Forza, keeping Barcelona's 14-turn no-chicane and 16-turn chicane layouts distinct.
- Stop showing race finishing, grid, and position-change ranks for practice sessions, including LMU test days; retain raw simulator timing ranks.
- Place qualifying position before Start on the race timeline instead of alongside Finish.
- Keep the New experiment dialog header and footer visible while its form content scrolls.
- Keep the track map full height beside a scrollable circuit reference, place compact stats above sector boundaries, and remove the redundant laps-recorded stat; stack track details on mobile.
- Show ACC track lengths derived from available circuit outlines instead of leaving length blank.
- List sector turns as separate bullet rows and keep Trap notes anchored to the bottom of track guide cards.
- Restore Brands Hatch T7 Dingle Dell as a separate right-hand kink between T6 Westfield Bend and T8 Sheene Curve, including track labels and segment previews.
- Reduce oversized Best, Median, and Worst lap Stats times; keep typography readable at different panel widths and text sizes, and label sector totals as theoretical best and delta.
- Place Replay immediately after the lap number in the track lap table.
- Sort every data column in the track lap table, including car, class, session type, sectors, and notes; keep missing sector times last in either direction.
- Align selected-lap Compare and Delete actions with the lap table in the existing desktop header row without shifting the table; keep actions above lap cards on mobile.
- Apply the Laps car filter to the Community Leaderboard, matching car names despite display punctuation differences.
- Place the Laps label and filters before the Stats and Community Leaderboard tabs in a shared desktop header, keeping the reference panel left and lap list right.
- Use available workspace height across track detail tabs, keep overflowing content scrollable on desktop and mobile, and keep community leaderboard headers visible while scrolling.
- Replace the track map in Laps with full-height Stats and Community Leaderboard tabs beside the lap list, align table headers, remove redundant leaderboard labels, and use the same Replay action as Sessions.
- Remove duplicate borders around Sector Ledger and Segment Ledger tables in session Analyse.
- Show a pointer cursor across clickable recent session rows on Home, including track buttons.
- Show pointer cursors on enabled shared buttons and toggles, including toggle groups, while disabled controls retain default cursors.
- Choose visible games with labelled, keyboard-accessible switches in a grouped settings list.
- Use shared inputs with transparent backgrounds and cyan focus borders for searches, including searchable selectors.
- Keep input borders at 1px when focused, matching table borders; use cyan focus borders across shared controls instead of gray or purple.
- Give segmented toggle groups a black background that stays black on hover, with a thin cyan border and cyan text on the selected option.
- Keep the Sessions Favorites label neutral when enabled, while retaining the highlighted star.
- Blend expanded session lap tables into their parent with transparent backgrounds and headers, without an upper divider or separate table frame on desktop and mobile.
- Place lap favorite and replay actions together after the lap number, keep checkbox columns compact, and group right-aligned sectors beside lap time while Notes uses available width.
- Sort expanded session laps by sector times and notes; keep missing sector times last in both directions.
- Give all table headers hover colors and cyan active-sort text, and make shared sortable headers clickable across the whole cell.
- Display session, lap, and experiment timestamps in the system's local timezone.
- Use recorded lap validity for completed ACC laps when available; preserve existing rules for legacy ACC recordings.
- Restore AC Evo track-limits classification when reprocessing recorded laps.
- Measure suspension spikes from raw wheel travel rather than normalized travel, which can collapse to zero when calibration data is missing; distinguish spikes from confirmed rumble-strip impacts.
- Show highest-severity lap insight findings first within each category.
- Report Counter-Steer only for observed steering reversals against continuing corner rotation, not ordinary turns with game-specific yaw sign conventions or unverified rear traction loss.
- Restore sustained understeer and oversteer findings in ACC/AC Evo replays when multiple capture frames share one simulator timestamp.
- Use simulator time for lap insight detection across supported games, independent of recorder arrival time; restore checks on older ACC captures without frame timestamps.
- Show detector findings for the primary lap alongside tune issues in session Analyse, without loading full replay telemetry.
- Stop treating ACC and AC Evo tyre/road vibration as TC or ABS intervention; label ACC physics-signal findings as possible rather than game-confirmed, and use AC Evo's explicit aid-active flags for confirmed findings.
- Keep expanded session lap tables within mobile viewport with internal horizontal scrolling, separate replay actions, and rounded corners.

### Internal
- Enforce complete segment turn coverage against layout facts across committed game geometry, including LMU; reject missing, duplicate, extra, and unnumbered turns without historical gap exemptions.
- Preserve curated segment overrides during generation and apply that protection to Brands Hatch across ACC, AC Evo, and Forza; remove stale Dingle Dell gap exceptions.
- Automatically mark dev-panel segment saves as curated overrides and retain override protection when editing sector boundaries.
- Centralize the Sessions Favorites control in the shared Toggle component with optional star rendering and built-in active styling.
- Keep PR Storybook comparisons advisory for new, changed, and missing screenshots; preserve preview artifacts and warnings when either render is incomplete.
- Keep the SearchSelect Storybook menu open after interaction checks and wait for visual readiness before capture, preventing missing PR comparison screenshots.

## v0.19.0 - 2026-09-28

### Breaking
- Open lap replays from session links; old track/car/lap query links no longer work.
- Older RaceIQ versions cannot open new recordings; keep current version installed to replay captures made with it.

### Features
- Add Le Mans Ultimate support.
- Store recordings from every supported game in a lossless sparse format and convert older recordings in the background; measured raw captures use up to 98% less space while existing laps remain available.
- Preserve real pauses and capture gaps in replay across supported games.
- Live dashboard moved to bottom of sidebar, outside game-specific navigation.
- Use French and Italian interfaces, with expanded German translations across setup, analysis, telemetry, sessions, and assistant screens.
- Review lap-analysis checks by category in Analyse, including findings, clear checks, and unavailable checks.
- Chart each wheel's rotation speed in lap replay when available.
- Toggle racing lines in 3D scenes when track has a line.
- See springs and drivetrain in 3D scenes without View switches.
- See inner, middle, and outer tire temperatures beside separate core readings in 2D and 3D views.
- See Assetto Corsa Evo and Competizione branding on home cards.
- Open Lap Analyse within selected session without choosing car or track again.
- Choose from OpenAI models available to configured API key.
- Delete old or selected lap recordings from Storage settings or Sessions, or opt into age-based automatic cleanup (off by default); keep lap and sector times and session details, with favourites protected from cleanup.
- Find cleanup controls in separate Storage tab, with cache controls in Cache tab.
- Filter Sessions to favourites.
- Use WebGPU for 3D replays, onboarding previews, and model comparisons where available, with WebGL2 fallback.
- Pause 3D scenes without recurring redraws.
- See recent sessions rather than individual laps on game and global home pages, including sessions without laps.
- Expand static lap detection in Analyse for sustained oversteer, tire-pressure imbalance and rapid loss, ACC/AC Evo braking overshoots, observed or inferred aid activity, tire-temperature patterns, DRS left closed on eligible F1 full-throttle straights, ERS depletion, and low corner-exit throttle.
- Sort laps by S1, S2, or S3 sector time in Analyse session lap-selection dialog.
- Seed Forza's recorded pit inlap and outlap for demo data.

### Fixes
- Restore track and car context when opening Compare chats from saved laps.
- Open session-level Analyse from lap Actions using its current menu label.
- Discard stale Compare lap selections from another game, track, or car so valid laps can be selected without mismatch errors.
- Replay recorded frame times across supported games while keeping older recordings without timestamps playable.
- Keep exported lap slices within their source sessions and preserve lap positions after recording conversion.
- Stop invalid recordings from producing misleading replay.
- Do not prompt to convert newly imported recordings again.
- Offer lap reprocessing after older recording conversion finishes instead of interrupting conversion with stale-lap prompts.
- Keep RaceIQ usable and recording during older recording conversion.
- Restore recording-conversion progress after browser refresh in compact “Migrating old recordings” card that shows savings once.
- Reprocess every segment of large imported sessions while keeping lap notes and favourites when lap numbers change.
- Draw ACC track edges and centre lines correctly in installed builds.
- Label brake temperatures clearly in tire diagrams.
- Show Forza's single tire-temperature reading across full-height 2D tire shape rather than inventing separate bands.
- Keep Analyse map overlay menu clickable on narrow screens.
- Mark AC Evo tire surface-profile checks unavailable when only one representative surface reading exists.
- Preserve AC Evo's inner, middle, and outer surface temperatures in newly recorded or reprocessed Analyse laps instead of using one representative reading.
- Resize Analyse telemetry charts with their container instead of stretching traces after layout changes.
- Restore traction-state colors on 3D tire trails.
- Show available surface and carcass temperatures in separate 3D wheel-card rows, using representative readings only where detailed bands are unavailable.
- Use OpenAI-compatible endpoints without saved API keys for auto-tune and driver-profile AI, as already possible for analysis and chat.
- Keep 3D replay grid at one-metre spacing and anchored to track through turns without line flicker.
- Show larger replay tires with mirrored surface-temperature segments on both tread edges, separate carcass and core layers, and brake temperature beside each wheel when available; remove slip-angle and slip-percent labels from wheels.
- Show wheel rotation speed as a positive magnitude in Analyse, including existing recordings.
- Keep Analyse 3D playback responsive on long laps while preserving tire-temperature profiles and input overlays
- Restore full-size 3D car views and temperature-colored brake discs
- Announce simulator-specific tire temperatures with selected units in 3D views
- Load large recorded sessions for lap review without exhausting memory
- Include more detail in exported diagnostics.
- Keep Analyse timelines clear and responsive near recording gaps.
- Enable mouse-wheel zoom on Track Detail maps after track data loads or tabs change.
- Keep telemetry cleanup effective while session compression runs.
- Prevent session reprocessing from restoring removed recordings; retain lap favourites when reprocessing replaces laps and protect newly favourited recordings during cleanup.
- Restore saved fuel consumption in experiment lap metrics.
- Open session import dialog from Sessions toolbar.
- Align settings switch thumbs with their on/off states.
- Clear outdated session recording references when files are already missing during cleanup.
- Refresh cache and recording storage totals while Storage settings stay open.
- Use consistent switch controls for boolean settings and view toggles.
- Restore AI Analysis button on lap replay and label Sessions' per-lap action Replay.
- Run completed-lap tuning analysis only when AI Engineer requests it in an experiment, not during recording.
- Reduce memory use and recording slowdowns during live capture, session compression, and diagnostic recording shutdown.
- Keep Forza Motorsport sessions active through pit service, including missing pit telemetry.
- Mark Forza pit-entry and pit-exit laps invalid when pit-service evidence supports it.
- Record final Forza laps and retain elapsed first-sector time when telemetry resumes.
- Stop treating Forza normalized lateral slip as physical slip angles in lap analysis.
- Avoid wheelspin and traction-loss findings when simulator lacks wheel-rotation telemetry.
- Distinguish partial wheel lockups from wheelspin in lap analysis.
- Keep sustained-event findings consistent across sample rates and recording gaps.
- Avoid flagging flat-out straights and smooth corner throttle as poor pedal control.
- Treat normal aid intervention and unverified corner observations as information, not driver weaknesses.
- Apply equivalent tire-temperature thresholds in Celsius and Fahrenheit.
- Preserve corner racing-line evidence on laps with long straights.
- Avoid treating display-scaled suspension movement as physical bottoming.
- Center Forza steering correctly in lap metrics and driver-style analysis.
- Compute missing lap insights for explicitly requested driver profiles without rerunning them during background refresh.
- Keep overlapping lap-insight computations from overwriting explicitly rerun results.

### Internal
- Bind development UDP telemetry to Forza's default port `5301`, configurable with `RACEIQ_DEV_UDP_PORT`.
- Keep seeded sessions' source metadata consistent with live recordings so conversion eligibility no longer needs a seed exception.
- Verify seeded database upgrades against migrations pending from PR base.
- Seed responsive screenshot databases with converted imports to avoid migration prompts.
- Include seeded raw recordings among conversion candidates so clean seeds exercise migration prompts.
- Expand diagnostic logging.
- Make standalone client tests compile translations before running; repair AI evaluation command and browser test typechecks for release validation.
- Isolate each local Bun test process in its own database so concurrent release suites cannot wipe one another's state.
- Expose a local Storybook base-versus-worktree comparison command without committed screenshot baselines.
- Run `bun dev` concurrently in Git worktrees with branch-specific Portless URLs, independent backend ports, and worktree UDP ports without restarting shared proxy.
- Ad-hoc sign compiled macOS builds so local Playwright servers launch instead of exiting before startup
- Restore synthetic 3D tire-profile showcases for every simulator in Storybook
- Enforce responsive visual baselines in pull-request screenshot CI and publish before/after/diff previews for review
- Fail PR screenshot-render jobs on Storybook test errors after uploading visual artifacts; wait for note-modal interaction readiness in snapshots.
- Align seeded Analyse and landing browser tests with session-scoped review/replay routes, session empty/error states, lap-only selection, and simulator-specific tire labels; exercise responsive Analyse against seeded replay data.
- Build developer-state snapshots only for active subscribers and serialize live telemetry at publication time.
- Cache versioned static lap insights for reuse, stale backfill, and explicit reruns
- Reuse per-frame wheel dynamics across static insight detectors
- Avoid per-frame wheel-speed sorting during effective-radius calculation
- Use linear-time rolling-window analysis for boost-drop detection
- Represent racing-line availability with an explicit per-track semantic contract
- Run every `bun run test:all` suite after failures, then report all failing suites.

## v0.18.0 - 2026-09-18

### Features

- Localize client analysis, telemetry, session-import, and developer-state UI with English and German messages

- Session review lets drivers inspect recorded ACC and AC Evo sessions, see top laps first, and open Analyse
- Live dashboards and Analyse pages show separate tire surface and core temperatures when simulator data provides both
- Live dashboards preserve each simulator's tire-temperature detail, including inner, middle, and outer surface temperatures plus core temperature
- RaceIQ runs on Linux as a non-root Docker image

### Fixes

- Balance-decision tooltips render correctly
- 3D tire trails follow wheel traction states across grip, slip, wheelspin, lockup, and idle
- Analyse AI chat and lap analysis work across configured AI providers
- Live dashboard tire diagrams use available temperatures, compact values, and separate radial surface slices and core temperature
- Live dashboard tire diagrams hide unavailable wear
- ACC pit strategy uses fuel limits because ACC does not provide tire wear
- ACC exports tire temperature only as its core channel instead of labeling reserved shared-memory fields as surface readings
- Recorded telemetry shows accurate surface details and temperature-freshness labels without unavailable readings
- Analyse positions turns and track maps correctly with or without world-position samples
- Analyse aligns peak tire and brake charts by distance while preserving per-wheel detail
- Compare and Analyse keep cursor tooltips synchronized
- Racing-line consistency scores appear only when at least two laps are available
- iRacing driver-profile navigation stays hidden when unsupported
- Lap analysis works with older F1 recordings that lack track or air temperatures

### Internal

- Compare base and pull-request UI renders on the same runner, publish visual changes as warnings, and clear stale UI-change comments and labels when no differences remain
- Run seeded database upgrade verification in PR and release CI when migrations change.
- Cover session review, Analyse, Compare, and navigation flows with seeded browser and Storybook tests
- Add UI-level agent testing.
- Increase Playwright E2E test timeouts by 20 seconds for more reliable CI runs.

## v0.17.0 - 2026-09-16

### Features

- Support optional bearer API keys for OpenAI-compatible endpoints, including local servers and hosted gateways
- Centralize AI provider credentials and endpoint setup, then select configured providers and models per AI feature with searchable controls
- Export one or multiple selected laps directly from Sessions toolbar

### Fixes

- Show F1 live dashboards' fastest valid lap and same-distance current-lap delta without completed-lap fallback
- Fix issues causing unreadable or unfinished recording files and incorrect lap timing
- Fix issue preventing live recording from restarting after deleting the active session

### Internal

- Run frontend theme-contract checks automatically during pre-commit.
- Regenerate and commit telemetry catalog artifacts during release finalization.
- Run Storybook standalone with deterministic offline fixtures and contract coverage.
- Add diagnostic logs that reveal missed telemetry and slow lap saving

## v0.16.0 - 2026-09-06

### Features

- Preserve the current page when switching games from the sidebar, falling back to the game root when unavailable
- Ship optimized GT3 and F1 car models: GT3 54.5 MB → 1.9 MB (52.6 MB saved, 96.5% reduction) and F1 66.4 MB → 6.0 MB (60.4 MB saved, 91.0% reduction), while preserving exterior visuals
- Reduce packaged image payload by 22.8% (18.1 MB across 890 images) and remove stale assets during upgrades

### Fixes

- Keep Analyse Data panel content and layout complete across supported views
- Use consistent shared controls across settings, setup, tuning, analysis, and update dialogs, including clearer selected unit states and keyboard-accessible modal interactions
- Open long recorded sessions in Analyse and Compare without loading the entire capture into memory

### Internal

- Narrow client response helper contracts to the fields each RPC and download path uses
- Pin GitHub Actions workflows to Bun 1.4 for consistent CI tooling
- Fail responsive screenshot CI when either render fails
- Compile all release feature code once and enable runtime overrides for Playwright E2E

## v0.15.1 - 2026-09-01

### Fixes

- Start RaceIQ successfully after installing a Windows release

### Internal

- Increase seeded Playwright E2E CI coverage from five to seven shards

## v0.15.0 - 2026-09-01

### Breaking

- Store primary database as `app.db` and automatically move older `forza-telemetry.db` files; resolve dual-file directories before startup because RaceIQ refuses to overwrite either
- Rename dashboard routes from `/dash` to `/portable` and reorganize sidebar game navigation.

### Features

- Classify imported laps as Mine or Others, filter sessions and owned statistics by ownership, preserve cross-tab selections, and label Compare/Analyse laps with ownership
- Persisted cross-game race results with qualifying, podium, fastest-lap, pit, strategy, and position-timeline summaries, plus idempotent historical backfill
- Configure driver-profile AI output tokens with provider-advertised limits
- Use simulator-independent semantic telemetry for live dashboards while keeping native packet inspection in the development panel and recording bytes unchanged
- Toggle ACC and AC Evo reference racing lines alongside other Analyse overlays in both 2D and 3D views

- Load high-fidelity Compare zoom ranges faster by reusing prepared course-distance alignment data instead of recomputing full-lap spatial alignment
- Detect imported file contents before accepting ZIP/BIN session data and reject unrelated archives
- Improve ACC and Assetto Corsa Evo MoTeC `.ld`/`.ldx` imports with reconstructed racing lines, canonical telemetry, setup/ownership metadata, explicit source limitations, smoother car orientation, and better-aligned replay telemetry.

### Fixes

- Improve lap-line fitting to track boundaries
- Stop showing ACC tire wear and degradation as live data because ACC does not export either channel
- Keep tuning dashboards scoped to the selected simulator and preserve unavailable track coordinates instead of drawing zero-valued positions
- Avoid fetching community leaderboard data during startup; load it when the leaderboard is first requested.
- Preserve every iRacing SDK tick around lap completion so saved laps begin at start/finish without telemetry gaps
- Show iRacing live fuel bars using tank capacity reported by simulator session data
- Show partial throttle and brake correctly in iRacing Pit Crew bars and telemetry traces
- Keep live dashboards from flickering back to Waiting for telemetry, clearly label measured source telemetry frequency, and maintain the configured browser refresh cadence
- Raise Windows timer resolution during ACC, AC Evo, and iRacing capture so native polling no longer collapses onto the default timer tick
- Make stale-session reprocessing recoverable with retry and dismissal actions, accessible progress states, and clear failure feedback
- Skip recordings from games unavailable in the current RaceIQ build during stale-session checks and bulk reprocessing
- Skip unavailable raw captures during stale-session reprocessing instead of failing the entire maintenance run
- Keep newly started session captures from being removed by concurrent storage cleanup
- Open RaceIQ faster by skipping unnecessary historical race-result work during startup
- Show actionable, neutral guidance when AI provider, credentials, or model configuration is incomplete
- Keep iRacing lap replay within saved frame boundaries so telemetry from the following lap is not included
- Report telemetry freshness from each source's own update time and mark incompatible clock domains as unknown instead of current
- Highlight only one fastest lap per sector in session and live lap tables
- Exclude pit-entry and pit-exit laps from pace, sector, consistency, improvement, and theoretical-best metrics
- Preview and import iRacing IBT recordings larger than 128 MiB without upload connection failures
- Ignore one-frame iRacing lap-counter resets that created invalid duplicate lap numbers in session recaps
- Show iRacing steering direction and signed values correctly in live views, Analyse, Compare, and saved recordings
- Roll iRacing wireframe wheels in Analyse when per-wheel rotation telemetry is unavailable
- Show iRacing lateral G-force on the correct side during turns
- Use official iRacing turn labels consistently across Analyse maps, segment lists, comparisons, chats, and tuning insights
- Draw iRacing left-turning oval laps in the correct direction on Analyse track maps
- Restore the moving car pointer on iRacing Analyse track maps
- Honor Analyse and Compare URL state so saved chats open with their AI panel visible and comparison cursor links are preserved
- Restore experiment version loading, editing, deletion, and recovery after the version API rename
- Keep Analyse insight navigation aligned on desktop and move the timeline tracking bar when stepping through events
- Do not report wheel lockups or brake traction loss for iRacing laps when source telemetry cannot identify them
- Show fuel used in litres for iRacing, ACC, and Assetto Corsa Evo instead of treating litres as percentages
- Align game metric contracts with catalog-backed semantic bindings; show Forza source-native Grip Ask and normalized lateral slip while hiding unsupported physical metrics.
- Hide unsupported telemetry channels and label iRacing pit snapshots instead of presenting normalized zeroes as live data
- Keep semantic live dashboards accurate across temperature units, unavailable tire channels, pit state, tire compounds, grip history, and traction indicators
- Resolve car and track names on the global home page in each lap's game context
- Treat tracks without optional boundary geometry as available instead of failed requests
- Open Analyse from home and session recaps without a full-page white flash
- Keep Analyse responsive while loading and playing large laps or recovering from server disconnects
- Keep Analyse 3D playback at configured 60 or 120 FPS while telemetry panels update
- Prevent 2D and 3D Analyse playback from exhausting browser memory during telemetry updates
- Keep repeated client errors and diagnostics logs from consuming unbounded memory, network, and disk space
- Keep the welcome wizard responsive and show throttle and brake input lines in its preview
- Restore lap and session history when upgrading databases affected by overlapping schema migrations
- Keep the Compare loading message hidden after comparison data is available
- Show both lap position markers on iRacing Compare maps when recordings do not contain world coordinates
- Cover the full page when settings are open so background content is consistently dimmed and dismissible
- Use semantic tabs for Analyse visualization modes and Data/Insights navigation
- Keep Compare panel framing consistent by removing the track-map card outline and completing the AI Analysis panel border
- Keep setup track names neutral and expanded setup details free of accent backgrounds
- Keep expanded session lap tables aligned and show sector columns when lap sector timing is unavailable
- Keep older lap telemetry available when legacy storage is the only replay source or a raw capture fails
- Make every app workspace reflow across phone, tablet, odd-shaped, and desktop windows without blocking device or rotation gates
- Match primary button backgrounds to the neutral gray button surface
- Highlight the active sector-blip setting with a cyan border
- Keep analysis and comparison pages usable on wide, low-height displays
- Resize the comparison track map with a persisted splitter and keep the AI Analysis control right-aligned
- Keep Compare map markers, telemetry inputs, and deltas aligned by track position after crashes, spins, shortcuts, and off-track detours
- Keep overlapping Compare lap markers on one shared map position instead of visually separating red and blue dots
- Render Compare overview hover as one white dot while retaining separate lap dots in the zoomed map
- Show corner and straight times on iRacing analysis laps without world-position telemetry
- Keep table text, guide cards, and setup rows consistently scaled without overflowing, and align Tracks sorting with Track Detail tabs without extra divider spacing
- Use one consistent table layout, spacing, alignment, and borderless sortable-header style throughout dashboards and analysis views
- Open Forza setups directly in the tune browser without obsolete Car Tunes and Wheel / FFB tabs
- Place setup car and track filters beside setup actions for faster access
- Use compact, borderless searchable filters for setup cars and tracks
- Remove the setup source-row container styling and keep refresh aligned with its filters
- Keep live telemetry stable during route and game transitions by resolving car names from each packet and skipping invalid track metadata requests
- Group rear setup controls with their populated mechanical-balance section
- Close searchable dropdowns, including Analyse lap selection, after choosing an option
- Show vehicle roll in the correct direction on the Analyse attitude indicator
- Keep Analyse attitude indicator and roll/pitch readouts moving while replaying saved laps
- Restore Analyse Data panel rows, section grouping, source-native tyre temperatures, copied values, F1 ERS/DRS details, and green throttle traces on both 2D and 3D views
- Reduce unnecessary network traffic during update checks when release tags are unchanged
- Keep live track maps from repeatedly refreshing track boundaries after boundary data loads

### Internal

- Read release notes from GitHub release bodies instead of downloading release-note assets
- Use explicit comprehensive Storybook stories for visual baselines so shared layouts cover every supported field without simulator fixture churn
- Benchmark telemetry parser and replay performance with reproducible Mitata CPU guardrails and separate report-only storage I/O measurements
- Stabilize benchmark regression checks with paired CPU samples, retained-heap probes, and counterbalanced base/current runs
- Speed Vite development startup with compact locale modules, no development declarations, cached unchanged compiles, and pinned Inlang compiler modules
- Replace first-party Zustand stores with TanStack Store and add development-only unified TanStack Devtools panels
- Parallelize Bun unit and integration test execution with dedicated suites and isolated databases
- Reject ordinary tests that are missing from or duplicated across unit and integration shards in local hooks and CI
- Keep benchmark comparison checks green for fork pull requests when comment permissions are read-only
- Speed Storybook visual snapshot CI with a test-optimized static build and concurrent workers
- Replace Biome with Oxc for repository linting and formatting
- Consolidate game raw telemetry routes behind one dynamic route and default seeded E2E runs to two workers
- Split seeded Playwright coverage across five fully parallel 15G shards to reduce runner memory pressure
- Document DeepWiki MCP as the preferred first pass for codebase discovery
- Catch repository-wide staged lint violations before commit and generate localization modules before root type-checking
- Preserve complete exports when startup-job tests mock background schedulers
- Cache prepared Compare course-distance alignment indexes per lap pair and reuse them across base and range requests to reduce repeated spatial work
- Cover Compare cursor and map-marker alignment with focused unit and seeded browser regressions
- Keep tune prompt formatting compatible with game-specific setup blobs
- Require repo-wide Biome and root TypeScript checks in CI, backed by the Biome 2.5.6 schema and recommended preset syntax
- Allow telemetry catalog validation to bootstrap when the base branch has no committed catalog
- Deduplicate telemetry catalog provenance hashes so generated review diffs stay focused on meaningful mapping changes
- Organized automated tests by domain, split oversized suites, and centralized shared test support
- Use compact real iRacing Daytona telemetry with a complete pit cycle and live estimated-lap replay in seeded development data
- Distinguish clean page reloads from unexpected browser termination in client diagnostics
- Keep production builds from bundling development-only Mastra dependencies
- Added complete telemetry-first semantic catalog with units, descriptions, per-game fidelity mappings, full parser/setup source inventories, stable iRacing SessionInfo setup leaves, detailed sector relationships, and persisted detailed tire temperatures
- Restored live-dashboard Storybook runtime context and added same-renderer local visual comparison before canonical Linux baseline generation
- Expanded visual regression coverage to 97 fixture-seeded responsive app states plus 17 Storybook states, covering every game, high-risk screens, track and experiment details, reusable primitives, navigation, dialogs, and viewport-positioned menus
- Added a local main-versus-worktree UI comparison report using the same responsive and Storybook screenshot inventory as pull-request previews
- Compare screenshot previews against each pull request's base branch and revision instead of current main
- Deterministic iRacing recording and replay coverage through the production parser pipeline
- Preserve complete iRacing SessionInfo YAML in recordings while keeping historical captures replayable and telemetry deltas compact
- Add fixture-seeded cross-game route and lap playback end-to-end coverage
- Completed fixture-seeded browser workflow coverage across Sessions, Analyse, Compare, Driver, Experiments, Chats, Tracks, Cars, Setups, Dash, developer tools, compiled binaries, and emulated devices
- Define setup form sources through typed catalog entries and expose iRacing setup metadata for future setup views

## v0.14.0 - 2026-08-05

### Features

- Analyze recent driving trends across up to 30 laps, with measured style, consistency, time-loss, and optional AI coaching
- Run versioned tuning and driving experiments in ACC and AC Evo, with setup changes, coaching drills, lap review, and car-or-driver focus
- Import MoTeC logs as normal sessions for analysis, comparison, and experiments
- Export and import individual laps or complete sessions as portable compressed captures
- View release history in Settings and see the installed version in the sidebar
- Move app navigation from the top bar into a left-hand sidebar, with a responsive mobile navigation drawer
- Copy AI Compare conversations as JSON and resume or regenerate analysis chats with complete persisted history
- Generate detailed, sector-aware lap-analysis results with consistent provider and settings handling
- Automatic driver profile metrics with optional, configurable background AI coaching and auditable run history
- Runtime-discovered iRacing cars and tracks, resolved by the SDK's native identifiers
- Support for iRacing's source-defined sector layouts, including two-sector ovals and layouts with more than three sectors
- View all release notes since your installed version in the app

### Fixes

- Keep unfinished game integrations and experiments out of production releases
- Make settings, onboarding, analysis, comparison, and experiment controls clearer and more consistent
- Show actionable guidance when AI provider, credentials, or model configuration is incomplete
- Keep chat drafts, submitted prompts, loading states, and conversation history consistent across AI surfaces
- Restore setup-seeded experiment branches and make branch deletion explicit
- Improve setup browsing with faster filters, clearer track and car context, and direct Forza tune access
- Keep analysis tables, tabs, maps, cards, and responsive layouts aligned across desktop and compact displays
- Improve session and sector tables when timing data is sparse or unavailable
- Show every registered game in storage settings, including games without recorded sessions
- Keep connection status, theme tokens, button surfaces, and sector-blip selection visually consistent

### Internal

- Renamed generic session recorder API to reflect support for UDP and shared-memory telemetry
- Centralized settings-aware AI provider resolution with request-scoped credentials and shared readiness handling
- Stabilized Storybook dashboard capture readiness, aligned PR preview comparison with Playwright's material-diff policy, and restricted baseline writes to the pinned Linux renderer
- Made Storybook snapshots own an exact-port server and retry cold preview preparation
- Restored the ACC live-dashboard fuel bar in fixture-backed previews
- Consolidated live dashboard routing across all supported games while preserving game-specific URLs
- Consolidated per-game car, track, and compare routes into shared dynamic game routes
- Added a disposable development database seed from committed telemetry fixtures
- Consolidated shared sessions, chats, analysis, driver, and experiment routes across all supported games
- Tolerate sparse screenshot antialiasing differences while preserving substantial visual regression reporting
- Centralized theme-overridable frontend colors, typography, tracking, surfaces, semantic states, telemetry, game branding, manufacturer, and team design tokens
- Added focused CSS resolution adapters for Canvas and uPlot renderers, backed by theme contract and Storybook snapshot coverage
- Updated workspace dependencies and regenerated root Bun lockfile
- Use `import.meta.dirname` in Vite config for native config-loader compatibility
- Avoid initializing Mastra observability during standalone database seeding
- Close disposable seed-test SQLite clients before removing temporary data directories

## v0.13.0 - 2026-07-16

### Features

- New lap insight detectors and server-side computation
- Static corner names and sector data from track geometry
- Session recap card with sector-coloured track map
- Curated turn numbers and track Info pages for expert guides
- AC Evo car and track extraction updates

### Fixes

- Separate Power and Torque rows in analysis
- Correct ACC centreline for corner detection
- Correct AC Evo track and car resolution

### Internal

- Backfilled from the pre-changelog GitHub release body
