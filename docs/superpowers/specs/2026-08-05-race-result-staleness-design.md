# Race-Result Staleness Notification Design

## Goal
Expose stale race-result processor status and let users rerun reconciliation from both the global notification and Settings.

## Scope
- Detect stored `session_results.processor_version` values different from `RACE_RESULT_PROCESSOR_ID`.
- Include sessions with no stored result as not stale for this feature; existing read/startup backfill handles missing rows.
- Provide a reconciliation-only bulk action. It must not reparse telemetry or alter lap boundaries.
- Keep startup backfill as a safety net, while surfacing version-stale rows to the user.

## Architecture
Server adds stale race-result queries and a websocket notification payload containing count and current processor version. A bulk endpoint processes stale session IDs sequentially, broadcasts per-session progress, and clears the persisted notification when complete.

Client stores race-result status separately from lap-detector status. The root-level prompt gives immediate access; Settings Diagnostics renders the same status, action, progress, completion, and retry/error state from the shared store.

## User-visible behavior
- No stale rows: Settings shows race results up to date; no global prompt.
- Stale rows: Settings shows affected count, current processor version, rerun available, and a Recalculate action; global prompt mirrors the action.
- Running: both surfaces show completed/total progress and disable duplicate starts.
- Complete: status refreshes to up to date and progress remains visible until dismissed or replaced by a new stale notification.
- Failure: action reports error and preserves rerun availability.

## Error handling
The endpoint processes each stale session independently, returns per-session reports, broadcasts progress after each attempt, and clears only when all selected sessions have been attempted successfully. A failed run remains rerunnable.

## Testing
- Query helpers count and list only rows with an older processor version.
- Bulk endpoint invokes reconciliation for stale sessions, broadcasts progress, and preserves stale state on failure.
- Client store tracks status/progress transitions and shared Settings/root rendering uses the same state.
