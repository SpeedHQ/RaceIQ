# Review fixes integration contract

Status: agreed from the supplied findings and existing contracts; no unresolved product decisions.

Plans: [UI](review-fixes-ui-plan.md), [backend](review-fixes-backend-plan.md), [tooling](review-fixes-tooling-plan.md).

## Ownership and boundary

The main session owns integration and verification. OMP workers own disjoint production scopes. Preserve existing public operations, authentication, ordering, pagination and error contracts except the additive update capability below. No commits, desktop control, unrelated refactors, or fake production fallbacks.

### Capture readiness

Existing `lap-capture-ready` notifications retain their current shape. A published live lap must refresh authoritative `processing` metadata before `session-laps` broadcasts. `standaloneCaptureReady: true` does not imply LMU opponent indexing is complete. Existing processing projection remains authoritative. Clients refresh sessions, laps, `track-laps`, and opponent catalogs on accepted readiness events; preserve attempt/sequence fences and debounce behavior.

### Updates

Extend existing version/update state with required `externalUpdateUrl: string | null`. It is an HTTPS GitHub release page for non-Windows installations that are not explicitly externally managed; it is null for Windows installer and Docker-managed installations. `updatesDisabled` remains required boolean and means the in-app installer cannot run: true on non-Windows or when `RACEIQ_DISABLE_IN_APP_UPDATE=1`. `downloadUrl` must not advertise a Windows installer on non-Windows. Preserve nullable `latest`, version/release-note fields, existing check/apply operations, and their authentication/error behavior. Existing apply rejects unsupported installation; UI must never invoke it for external or managed installations. No pagination applies.

Examples: Windows `{ updatesDisabled: false, externalUpdateUrl: null }`; Linux AppImage `{ updatesDisabled: true, externalUpdateUrl: "https://github.com/SpeedHQ/RaceIQ/releases/latest" }`; Docker `{ updatesDisabled: true, externalUpdateUrl: null }`. When update available, Settings and modal show external download/instructions for external mode, Docker instructions for managed mode, and Install only for installer mode. User-facing text uses all supported locales.

## Integration acceptance and E2E scenarios

IDs match supplied finding numbers. The plans own detailed cases; this section owns shared integration scenarios.

- E4/AC4: isolated real recording through production pipeline callbacks publishes a completed lap; observed session-laps snapshot contains authoritative processing state. LMU remains gated until its real index prerequisites complete; missing lap does not crash.
- E5/AC5: actual app track table initially shows processing; deliver accepted readiness event from application WebSocket path after real publication; query refetch updates Replay/Compare. Stale attempts remain ignored. Reuse existing compiled Playwright suite with isolated DB/capture fixtures.
- E12/AC12: run application with external update capability and controlled release discovery; Settings and modal expose external HTTPS download, no Install/apply request. Windows exposes installer; Docker retains container guidance; no-update and failed-check paths retain prior behavior. Extend existing app E2E fixtures; mocks may control GitHub but must not replace app version routes or UI integration.

Main session must execute relevant E2E scenarios and record observed outcomes. Unit tests/builds supplement, never replace integration proof. Windows/Linux packaged or native hardware scenarios unavailable on macOS remain explicitly unverified, not passed.
