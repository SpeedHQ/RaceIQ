# Recording frequency integration contract

Approved requirements: [full plan](recording-frequency.md). Owners: [UI](recording-frequency-ui-plan.md), [backend](recording-frequency-backend-plan.md). Shared artifacts owned by integration coordinator. Decisions below follow the approved plan; no unresolved cross-boundary decision.

## Recording package boundary
Format-level preflight, historical clocks, boundary/index planning, sparse/nested-iRacing reconstruction and streaming output belong to `@raceiq/capture-formats/session/downsample`. Backend-core supplies strict source iteration and fresh game-parser callbacks, then owns DB eligibility, storage locking, atomic publication, caches and Effect job lifecycle. The recording package has no dependency on backend-core. C4/C5 verification exercises the package through the real server API and supplements it with deterministic codec regressions.

## Settings
Existing authenticated GET/PUT `/api/settings`, existing partial-update merge/persistence. Numeric `recordingFrequencyHz`: 50|60|70|80|90|100, default 100. `sessionDownsampleEnabled`: boolean default false; `sessionDownsampleAgeDays`: 30|90|180|365 default 30; `sessionDownsampleFrequencyHz`: same frequency union default 50. Existing deletion fields/defaults remain false/90. All persisted fields required in complete settings, optional in partial request, never nullable. Live frequency updates only after successful save. Archival fields never change live frequency.

Both policies enabled requires deletion age > downsample age. Conflicting merged updates return 400 `{ code: "INVALID_RETENTION_POLICY", error: "Automatic deletion must be scheduled after automatic downsampling." }` before side effects. Other invalid settings retain existing 400 behavior.

## Archival API
Existing storage-route auth applies; no client paths, pagination or ordering parameters.
- POST `/api/storage/session-downsample/preview`: read-only 200 preview.
- POST `/api/storage/session-downsample`: 202 `{ accepted: true }` only after runtime-owned worker admission and storage acquisition.
- GET `/api/storage/session-downsample`: 200 immutable status snapshot.

Request: `{mode:"all",targetHz:50}` or `{mode:"older-than",olderThanDays:30,targetHz:50}`; enums as above. Strict unknown/invalid fields or malformed JSON: 400 `{error:"Invalid downsample request"}`. Conflict:409; unexpected admission I/O:500. Existing HTTP boundaries retain Zod; backend-core owns Promise facades.

Preview: `{request,candidateSessionIds:number[],fileCount:number,sourceBytes:number,skipped:Skip[]}`. Skip: `{sessionIds:number[],reason:"favorite"|"shared-age-conflict"|"missing"|"unowned"|"unsupported-format"|"unreliable-time"|"already-at-or-below-target"|"not-smaller"}`. Source bytes are not estimated savings.

Status: `{status:"idle"|"running"|"success"|"partial"|"error",request:Request|null,done:number,total:number,convertedFiles:number,freedBytes:number,skipped:Skip[],failed:{sessionIds:number[],message:string}[],error:string|null}`. Terminal snapshot persists until next admitted job; rejected start cannot reset it. Poll every second while running, refresh on mount/focus. No cancellation endpoint or cross-restart progress promise.

## Observable integration acceptance
- C1: onboarding shows six ascending choices, default100; saving50 survives reload and changes native admission without restart; failed PUT preserves selection/runtime. Exercise real onboarding plus settings API and fixture-backed source loops.
- C2: retention draft saves five policy fields together; 30/90 succeeds, equal/reversed enabled ages fail without persisted/runtime/socket change. Exercise Storage and real PUT/reload.
- C3: preview never mutates; explicit irreversible confirmation starts server-owned job; navigation/reload restores running/terminal status. Exercise real app/API against isolated canonical recording and DB.
- C4: successful50Hz archival reduces replay samples/bytes, retains endpoints/lap identity and invalidates derived caches. Real semantic-telemetry GET before/after must return200 and parseError:null. Favorite, MoTeC, unsupported, unreliable and age-straddling groups stay unchanged with reasons.
- C5: failures preserve authoritative source until atomic publication; retries skip established caps. Actual fixture-backed fault paths and partial retry status verify behavior.
- C6: scheduled downsample30/delete90 reduces40-day capture before deleting100-day capture; failure skips deletion. Strict exact-age boundary skips; just-older qualifies. Runtime smoke and deterministic lifecycle suite cover admission, timing and awaited shutdown.

Detailed edge handling and E2E setup/actions/assertions: full plan Verification and steps5–9, authoritative for implementation. No mock production fallbacks; UI fixtures may unblock independent development only.
