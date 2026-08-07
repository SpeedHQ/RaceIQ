# Lap Ownership Design

## Goal

Allow imported telemetry to be classified as driven by the current user (`mine`) or someone else (`others`). Replace the Sessions page's `Recorded`/`Imported` switch with ownership filtering while preserving cross-group selection and actions.

## Scope

Ownership applies to every supported import path: `.bin`, `.bin.gz`, `.ibt`, and MoTeC `.ld` imports (with optional `.ldx`). Ownership is stored at session level because an import creates a session containing one or more laps.

Live-recorded sessions and all existing sessions default to `mine`. The migration must make this default explicit for persisted rows.

## User experience

- Sessions toolbar offers `Mine` and `Others` tabs instead of `Recorded` and `Imported`.
- Switching tabs does not clear selected session or lap IDs.
- Selected items remain actionable across tabs:
  - compare selected laps regardless of ownership;
  - bulk-delete selected sessions/laps regardless of ownership.
- Import UI presents an explicit `Mine`/`Others` choice for every supported file type. Staged iRacing imports submit the choice at commit time.
- Compare and Analyse identify every selected/viewed lap with a `Mine` or `Others` label. Labels come from persisted ownership, never from the active Sessions tab.

## Data model

Add a session-level ownership field with a constrained application type (`mine` | `others`) and persisted default `mine`. Keep telemetry provenance (`source`, including `motec`) independent from ownership. Expose ownership in session and lap metadata contracts and all compare/analyse payloads that identify laps.

## Statistics and data access

Define one server-side owned-session predicate and apply it to all user-owned statistics and driver-profile aggregation. Foreign sessions remain available to general session/lap listing, comparison, and export. Filtering must happen in SQL before aggregation or pagination; client-side post-filtering is insufficient.

Existing statistics behavior remains unchanged for current data because existing/live rows resolve to `mine`.

## Import flow

Thread ownership through the common session import pipeline so all sessions created by one import receive the selected value. Standard binary import accepts ownership in its request. MoTeC passes ownership through its import options while retaining its source marker. IBT staging keeps the choice out of preview state and accepts it in the commit request, avoiding stale or mutable preview classification.

## Compatibility and migration

Add an append-only migration that adds the ownership column with a `mine` default and backfills existing rows. Read boundaries normalize unexpected/null legacy values to `mine` during rollout. No deprecated `Recorded`/`Imported` ownership semantics remain after callers migrate.

## Verification

Cover:

1. migration default for existing sessions;
2. ownership persistence for binary, MoTeC, and IBT imports;
3. Mine/Others Sessions filtering;
4. selection persistence across tab changes;
5. compare/delete operations spanning both ownership groups;
6. exclusion of `others` from owned statistics and driver-profile inputs;
7. ownership labels in Compare and Analyse;
8. visibility of foreign laps in general listing, comparison, and export.
