# shared/tuning

Shared tuning model and tuning-issue contracts for setup workflows and AI advice.

## Purpose
- Define tune catalog row shape and assignment records.
- Define analysis issue shape used by live and post-lap views.
- Keep setup-aware rendering typed across server and client.

## Key modules
- `types.ts`
  - `TuneCategory`, `TuneSettings`
  - `Tune`, `RaceStrategy`, `TuneAssignment`
- `issues.ts`
  - `TuneIssueKind`
  - `TuneIssueSeverity`
  - `TuneIssue`

## Browser vs Node boundary
- Browser-safe DTOs, no Node APIs.
- Both server stores and client UI consume these types.

## Dependency direction
- Depends only on primitive scalar fields; no framework dependencies.
- Downstream:
  - Server query/mutation layers (`server/db/*`, setup services)
  - Client components (`client/src/components/tunes/*`, including `tunes/track-focus/*`)

## Add/extend safely
- Preserve old issue JSON shapes when adding `TuneIssue` fields.
- Add tune fields with defaults in serializers and migration-aware render paths.
- If adding new `TuneIssueKind`, update UI label routing and any schema validation where literal sets are enumerated.
- Prefer direct imports, for example `import { TuneIssue } from "@shared/tuning/issues"`.
