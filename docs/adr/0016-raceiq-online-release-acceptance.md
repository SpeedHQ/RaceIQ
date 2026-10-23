---
status: accepted
---
# Close RaceIQ Online through evidence-gated remaining work

## Context

The accepted Online architecture is implemented with partial application/HTTP evidence. SDK0.2.1 publication, genuine F1/LMU paths and selected upload recovery/security scenarios are proven, but full E01–E19 release acceptance is not. Same-original uploads from two isolated app instances do not establish physical-device, Windows or lifetime-statistics merge acceptance.

## Decision

Retain the accepted single-user/native-ownership architecture and existing API boundary. Complete the 22 remaining items through stable R01–R22 acceptance criteria and shared V01–V22 real-system scenarios. Separate backend and UI implementation plans use one shared contract and may proceed in parallel after interface agreement; one integration owner controls shared artifacts and final cross-layer evidence.

Contain detector-queue saturation with bounded resources and truthful incomplete-capture provenance rather than process termination, silent loss or unbounded buffering. Local implementation review selected bounded admission including lifecycle waiters, serialized admitted-prefix drain and incomplete source closure, using existing recording-failed feedback before a fresh detector handles later input. This decision and local implementation are authorized; fixture, native-attribution, retention, Windows/hosted and legal gaps remain release blockers. Do not waive games or replace end-to-end evidence with mocks/static checks.

## Rationale and consequences

Reusing implemented infrastructure and valid evidence avoids a second queue, reducer, slicer or account model. Explicit per-scenario outcomes prevent a passing upload retry or isolated smoke from being presented as complete release certification. Implementation, operator approval, commits, deployment and desktop-control permissions remain separate from planning. Unsigned native telemetry still cannot provide an absolute authenticity or anti-cheat guarantee.

Plan: [Remaining work and acceptance registry](../plans/raceiq-online-remaining-plan.md).
Backend plan: [Owned backend work packages](../plans/raceiq-live-service.md#remaining-work-execution-amendment-2026-10-22).
UI plan: [Parallel UI work packages](../plans/raceiq-online-ui.md#remaining-work-execution-amendment-2026-10-22).
Shared contract: [Authoritative integration and release boundary](../plans/raceiq-online-contract.md).
Existing decision: [Accepted single-user, attribution and lifetime architecture](0011-raceiq-live-service.md).

This decision does not supersede the existing architecture decision or imply full implementation/release acceptance. Commit, deployment, operator legal approval and desktop-control authorization remain separate.
