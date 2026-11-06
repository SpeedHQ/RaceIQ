# Live Engineer package management backend plan

Contract: [shared API, release metadata and enablement](wizard-live-engineer-package-contract.md). Parent owns shared type/compatibility prerequisite; package and app slices proceed independently with fixed installer interface.

## Ownership/tasks

Package slice: Node-only `@raceiq/live-engineer/audio-installation` owns `validatePack(root, expectedPackageVersion?)` and `installPack(archive, installRoot, expectedPackageVersion?, expectedArchiveSha256?)`; preserve safe staged replacement, hash/path/version checks and cleanup. Migrate CLI/tests and remove old tooling-owned implementation/exports. Expected selected revision/digest checked in addition to compatible minimum revision. Update release builder/workflow to publish small metadata JSON alongside ZIP. No browser-safe leaf imports Node code.

App slice: backend service/routes/startup schedule and existing settings hooks. GET enriched status; POST fixed-source install and manual check; trusted stable-release discovery/metadata validation/newest-compatible selection; single-flight checks/install; real downloader; event invalidation; no public URL/version/path inputs. Inject local source/fetch and clock only at private test composition seam; production hardcodes trusted GitHub repository/derived asset URLs.

Automatic scheduler mirrors app cadence (startup 10s, four-hour interval) and checks release flag plus saved audio switches before every remote request. Existing settings hook triggers an immediate automatic check on both-off→enabled. Manual management requires release flag. Ignore individual malformed/missing candidates when another validates; report metadata failure if none validates. Failed checks clear untrusted offer and expose error; cached installed package stays usable. Check installed versions dynamically; avoid remote lookup on GET. Install latest trusted compatible candidate or pinned baseline; already-current no network; failure releases lock and preserves old files. Stop/cleanup timers using existing startup/shutdown ownership conventions.

## Acceptance/edges

B1/W3/W6: shared Node installer reused by CLI/app, real ZIP gives ready and audio is not bundled. B2/W4: network/non-2xx/hash/archive/path/version/disk errors never publish partial files; prior install survives, staging removed, retry works; concurrent installs 409. B3/W5/W7: installed supported newer revisions stay ready; remote metadata must match tag, engine, catalog, locale and minimum; choose newest compatible release without downgrading supported audio. Unsupported higher claimed revisions repair with the newest known compatible candidate (S7), not the baseline. B4/W8/W9: automatic requests absent when release/audio disabled; startup/interval/manual check state and error observable; WS invalidation emitted after completed check/install.

## Verification

Implement focused isolated installer/metadata/route/concurrency/clock tests, registered surgically in owner manifests. Use actual HTTP mirror and real archive for download/publication integration. Parent executes shared S1–S6 through app and browser; backend native-HTTP S7 proves repair/no-downgrade selection. Tests do not replace the browser integration scenarios. Report absent public release separately. Keep source/API docs and release metadata workflow aligned before final checks.
