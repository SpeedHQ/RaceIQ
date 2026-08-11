# Reconciliation Version Menu Tests

## Goal

Protect the update/reconcile menu triggers when a stored session was processed by an older version or has no recorded version/result.

## Scope

Add focused server-side automated coverage. No test-only UI controls and no Playwright coverage.

## Staleness rules

### Lap detector

A session is stale when it has a raw capture and its `lapDetectorVersion` is either `NULL` or is not one of the active detector IDs. A session stamped with an active ID is current.

The startup stale-session job must publish a `stale-lap-detection` WebSocket notification only when the count is positive. Its count must include both prior-version and versionless sessions.

### Race results

A session is stale when it has no `session_results` row, or its row has a `processorVersion` different from `RACE_RESULT_PROCESSOR_ID`. A session with the current processor version is current.

The startup stale-results job must publish a `stale-race-results` notification only when the count is positive. Its count must include both prior-version and resultless sessions.

The bulk reconciliation endpoint must select the same stale set, including sessions without a stored result, then persist each reconciled result using `RACE_RESULT_PROCESSOR_ID`.

## Test design

1. Extend query-level tests for detector staleness with current, old, `NULL`, and missing-raw-file fixtures.
2. Extend race-result storage tests with current, old-version, and no-result fixtures; assert stale count and IDs include only old/no-result cases.
3. Add startup-job tests with the WebSocket manager mocked/captured. Assert exact stale notification type and count for detector and result cases, plus no notification when all rows are current.
4. Extend the reconciliation-route test with a resultless session and assert the endpoint writes its current processor version.

## Boundaries

The tests validate server notifications that drive the existing reconcile menu. They do not render the React component or change its copy, layout, or action behavior.
