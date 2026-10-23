# Online extraction backend plan

Contract: [shared boundary, ON-01–06 and ON-E01–05](online-extraction-contract.md). Parallel UI plan: [UI](online-extraction-ui-plan.md).

## Scope and tasks

Own `packages/online/server/`, existing `src/` relocation, server/worker contracts and Online-specific HTTP/controller/service implementation currently in the backend app. Application keeps thin host bindings, process lifecycle, global DB/migrations/write coordination and platform operations. Existing native capture producers and app-owned DB queries remain shared services unless relocation is necessary to keep ownership correct and the graph acyclic.

1. Move browser-safe contracts to top-level `contracts/` and existing server source to `server/`; migrate consumers without compatibility shims.
2. Move feature routes/data/errors/auth page, Online local/profile/import controller logic into the feature using explicit typed host ports. Preserve Hono RPC inference and every validation/error path.
3. Reduce app integrations/worker entry to platform composition; preserve actual dedicated worker and credential secrecy. Avoid a backend-core↔Online workspace cycle; shared definitions/events belong in authoritative shared leaves or injected ports.
4. Relocate exclusively Online server tests/fixtures, preserving isolated process/runtime semantics and pre-existing edits. Integration owner owns shared manifests/config/lockfile and test registration.

## Acceptance and edge handling

ON-01/02/04: unchanged endpoint DTOs/status/auth/origin behavior, account/revision fences, worker failures, sign-out, queue/restart/ambiguous-delivery outcomes and original identity. Reuse current handling without semantic changes. ON-E01 covers HTTP/state failures; ON-E03 covers lifecycle/storage. ON-03 is proven by ON-E04 and acyclic Turbo graph. ON-05 uses ON-E05 discovery and selection.

## Verification and completion

Integration owner executes shared ON-E01–05, package regressions, actual worker/application entry, compiled/browser builds and root typecheck after implementation settles; records outcomes in the contract. Worker skips tests/build/lint/formatters. Final real integration is a completion dependency. No checkpoint, commits, deployment or desktop control.

The integration/test slice owns the ON-E02 startup extension for shared Playwright launchers and the Online package's loopback external API/OAuth fixture. Keep the production transport guard unchanged: the test child receives explicit loopback origins, a disposable trusted certificate and test environment. Exercise the complete compiled application, actual SDK callback, dedicated worker and persistence rather than a feature-only server.

Final integration: actual compiled Online worker startup, SDK/PKCE callback, typed HTTP fences, preference/name readback, sign-out, durable package regressions and contribution ledgers pass. All three build embedding lists include the worker entry. See the shared contract's [executed evidence and limits](online-extraction-contract.md#executed-evidence); Windows/hosted-provider/native-popup qualification is not claimed.

