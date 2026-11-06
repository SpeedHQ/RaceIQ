# Live Engineer package management contract

Plans: [UI](wizard-live-engineer-package-ui-plan.md), [backend](wizard-live-engineer-package-backend-plan.md). Versions and wire catalog remain owned by `@raceiq/live-engineer/audio-package` and `shared/racing/live/audio-catalog-version.json`.

## Agreed behavior

- Optional setup step after Sound asks to install Live Engineer **voice package**; Skip completes setup without downloading or changing Radio preferences. Install alone does not enable audio.
- Dedicated Settings → Live Engineer manages installation, displays installed/required/latest package and installed/required catalog/engine/locale, checks updates, and reuses Radio controls.
- Automatic update checks follow app cadence: 10 seconds after startup, then every four hours. Both release flag `liveSpotterEngineer` and at least one user audio setting (`radioSpotterEnabled` or `radioRaceEngineerEnabled`) must be true before every automatic remote request. Enabling audio from both-off triggers an immediate automatic check; disabling it prevents subsequent requests. Otherwise no automatic remote fetch or bottom-right prompt. Manual management requires release flag but does not require audio already enabled. Wizard/settings entry also respect release flag.
- Compatibility is exact engine/catalog/locale, with hardcoded **minimum** package revision. Newer recording revisions with same contract may install; incompatible engine/catalog/language releases must never be offered. This supersedes prior exact package-revision equality; required engine/catalog/locale remain hardcoded.
- Independent release publishes versioned ZIP plus small JSON metadata `{engineVersion:number,catalogVersion:string,packageVersion:string,language:string,sha256:string}`. JSON SHA-256 identifies ZIP bytes. Only stable published `voice-pack-<locale>-v<x.y.z>` releases in SpeedHQ/RaceIQ are candidates. Metadata identity must match tag and hardcoded compatibility; URLs are derived from trusted repo/locale/version, not caller input. Select newest compatible revision, not newest app release. Failed checks retain no newly trusted candidate, expose error, and never fabricate an update.
- Malformed or missing metadata for one release cannot hide another valid compatible release. Ignore incompatible identities. If no candidate validates and metadata fetch/parse failures occurred, report updateError rather than successful up-to-date status.

## Shared API/types

`GET /api/live-engineer/voice-pack`: existing status plus required fields `requiredCatalogVersion:string`, `installedCatalogVersion:string|null`, `installedLanguage:string|null`, `latestVersion:string|null`, `updateAvailable:boolean`, `lastChecked:string|null`, `updateError:string|null`, `installing:boolean`. requiredVersion is minimum supported revision; installedVersion is actual. ready means installed contract supported even when newer revision is available. Responses no-store and existing authentication/CSRF rules apply.

`updateAvailable` is true when a trusted compatible candidate can repair a missing/unsupported installation, regardless of that installation's claimed revision, or when it is newer than a ready installation. A supported higher installed revision is never downgraded by app installation.

`POST /api/live-engineer/voice-pack/check`: manual remote check, returning same status. Disabled release feature → 403 `{error:"feature-disabled"}`.

`POST /api/live-engineer/voice-pack/install`: no URL/path/version input. Install newest cached compatible candidate, or pinned baseline when no candidate is known; do not redownload an already-ready package unless a newer compatible candidate exists. Verify selected exact revision, ZIP digest when remote metadata provides it, contract, paths and all clip hashes before staged publication. Return HTTP 200 ready status only after success. Concurrent installation → 409 `{error:"install-in-progress"}`; failure → 502 `{error:"voice-package-install-failed"}` and prior files retained. Release feature disabled → 403. Remove temporary downloads/stages on all terminal paths.

Backend broadcasts `live-engineer-package-update` as invalidation signal after check/install. Client refetches status; no client-provided metadata becomes trusted. Settings and wizard share mutation key `live-engineer-voice-pack-install`. Pending install disables install/navigation; error allows retry/skip. Bottom-right update prompt appears only under enabled-feature rule and when compatible updateAvailable is true, supports Update and dismissal for that offered revision, and disappears after successful install/disable. Existing migration/Radio dock notifications must not overlap.

## Acceptance criteria

- W1 Optional wizard question and explicit Install / Skip; missing/status error never forces installation.
- W2 Skip creates no files/request, preserves audio preferences, and finishes setup; reopen can offer install again.
- W3 Real download/install yields ready, correct files and served audio; pending prevents duplicate actions/navigation; no restart needed.
- W4 Network/corrupt/incompatible/hash/disk failures show retry/skip and preserve prior package; concurrent install cannot race publication.
- W5 Already-current package does not redownload; compatible newer revision updates; incompatible newer release ignored.
- W6 Node installer owned by live-engineer package and reused by CLI/app; audio stays outside app bundle.
- W7 Dedicated settings shows accurate installed/minimum/latest revision plus engine/catalog/locale and check/install/update/error states; Radio settings remain usable and user-owned.
- W8 Startup/four-hour automatic checks only when release and audio enabled; manual checks update settings. Failed checks surface errors without fake availability.
- W9 Bottom-right compatible-update prompt, dismissal and install outcome work; disabling feature/audio removes prompt and prevents automatic requests. No prompt collision with existing notification dock.

## Shared E2E strategy; parent executes and records outcomes

Use actual production app/router/HTTP/WS, real setup/settings UI and isolated DATA_DIR. A controlled local HTTP release/ZIP mirror supplies real metadata and actual built ZIP; it must not replace update selection, downloader, validation, publication or UI API with mocks. Production has no arbitrary URL override. Reuse existing browser harness and append only focused scenarios where appropriate.

S1/W1/W2: fresh enabled-feature wizard without package → navigate after Sound → Skip → finish; assert zero install/download and unchanged Radio preferences. Disabled release feature omits step.
S2/W3/W6: mirror holds real ZIP response; Install → pending controls disabled → release bytes → compatible files/GET ready/FLAC 200 → finish.
S3/W4: mirror HTTP failure, bad ZIP/hash and unsupported catalog → error/retry/skip, old sentinel/files intact; valid retry succeeds. Two concurrent actual POSTs: one download, other 409. Unauthorized/disabled-feature POST denied.
S4/W5/W7: matching existing package → Settings installed/minimum versions and no redownload; mirror advertises newer compatible and newer incompatible revisions → Check for updates selects only compatible → Update installs exact selected revision → versions refresh.
S5/W8/W9: enabled release+audio, scheduler startup check against mirror → actual bottom-right prompt → dismiss then newer offer resurfaces → Update succeeds and prompt disappears. Both audio off or release off → zero automatic remote requests/no prompt; changing both-off to enabled triggers an immediate real check. Manual settings remains available only under release gate. Verify dashboard routes and migration dock precedence; measure the complete Radio stack so its changing callouts cannot overlap the prompt.
S6/W8: failed release/metadata check → visible error/no fabricated offer; retry recovers; missing/invalid/draft/prerelease/wrong-locale metadata ignored. Confirm automatic interval and disable transitions with controlled clock lifecycle coverage in addition to browser startup evidence.
S7/W5/W7: native HTTP API and real release/archive mirror → install supported 2.0.0 → declare installed 9.0.0 with supported catalog → no offer/no downgrade → declare incompatible catalog → offer cached compatible 2.0.0 and repair to ready. This distinguishes repair from downgrading supported audio.

Hosting release publication and native human listening are separate prerequisites, not local-mirror proof. If public baseline release is absent, production download must fail visibly and stay optional.

## Executed evidence — 2026-10-22

Actual production router, authentication, settings persistence, package singleton, native startup timer and WebSocket invalidation ran against isolated data directories. Trusted GitHub-shaped requests were transported to a real local HTTP mirror serving real ZIPs and SHA-256 metadata; no status, install, validation or publication APIs were mocked. Production client bundle was exercised in Chromium.

| Scenario | Outcome |
| --- | --- |
| S1 / W1–W2 | Wizard displayed optional step after Sound. Skip finished setup, persisted completion, kept both audio preferences off and made zero remote requests. Reopening offered installation. Disabled release omitted wizard step and settings entry. |
| S2 / W3 / W6 | Real held download disabled Install, Back and Skip. Concurrent POST returned 409. Release of actual ZIP produced ready 1.0.0 without changing preferences; served FLAC returned 200 with `fLaC` signature. Already-ready wizard showed Next without another install button. |
| S3 / W4 | HTTP failure, corrupt bytes, wrong advertised ZIP SHA, and a ZIP with valid SHA but incompatible internal catalog failed visibly. Prior ready revisions remained intact. An exclusive Windows clip lock forced publication EPERM/502; releasing it allowed same-process prompt retry to install 1.4.0 without restart. Protected app returned 401 for unauthenticated check/install; release-disabled app returned 403. No staging or temporary download directories remained. |
| S4 / W5 / W7 | Settings showed installed/minimum/latest versions and installed/required engine/catalog/language, with reused Radio controls. Manual checks worked with audio off. Compatible 1.1.0 beat incompatible 9.0.0. Already-ready install performed no download. Retry updated versions without reload. |
| S5 / W8–W9 | Actual startup timer made its first remote request after 10,004 ms and produced a WebSocket-refreshed bottom-right prompt. Both-off→enabled checked immediately. Dismissed 1.1.0 stayed hidden; 1.2.0 resurfaced. Prompt installation succeeded and disappeared; disabling audio removed it. Release-off with saved audio enabled still made zero automatic requests. Home, `/acc` and `/live` displayed the offer. At 600px width, prompt remained in bounds; Radio clearance was 8px and survived controlled dock expansion to 220px. An actual classification-migration WS snapshot suppressed the package prompt; dismissal restored it. |
| S6 / W8 | Release HTTP 503 and wholly invalid metadata exposed errors with no fabricated candidate; retry recovered. Missing/malformed metadata did not hide valid 1.2.0. Draft, prerelease and wrong-locale tags were not fetched. Controlled scheduler regression exercised four-hour callback, disabled gates and stopped lifecycle without remote requests after stop. |

Additional evidence: shared CLI installed into the same app data directory; extensionless builder output remained a ZIP with a separate identity/actual-SHA JSON sidecar. Focused installer/CLI/backend regressions passed (20 tests). Affected workspace typecheck/unit/tooling gates passed (50 tasks); lint passed (34 tasks); locale parity passed (2,759 keys per locale), shard ownership and frozen dependency install passed. Client built after direct locale compilation using a temporary configuration that omitted only the known Windows EPERM atomic-directory compiler wrapper.

Public release metadata currently returns HTTP 404. Local-mirror verification does not prove public hosting or human listening quality; publishing the independent voice-package release remains a distribution prerequisite.

Status-error edge (W1/W4): replacing the isolated installed manifest with a directory produced a real GET 500. Wizard kept Skip enabled; restoring the file and pressing Retry recovered the already-ready package without a redundant Install action.

Repair-boundary regression (S7/W5/W7): real native HTTP status/check/install endpoints and real ZIP mirror reproduced the unsupported higher-version bug before the fix. Afterward, supported 9.0.0 stayed installed without downgrade; incompatible catalog on claimed 9.0.0 repaired to the cached compatible 2.0.0. The permanent native-HTTP scenario passed with the remaining backend cases.

