---
status: proposed
---
# Derive 3 to Improve from the driver's own recorded session

## Context

Drivers need a quick answer to where and how to improve after a session. RaceIQ already has deterministic lap detectors, source-frame evidence, recording processing guards and a session Analyse feature. Detector symptoms do not establish an optimal driving line, a proven causal fault or guaranteed seconds saved.

The user selected their own session as the coaching basis instead of an external reference lap or AI-generated coaching. The remaining feature details are proposed, not accepted or implemented.

## Proposed decision

Extend the existing session Analyse Overview with up to three ranked practice priorities. Every card identifies a location, an observed pattern, one suggested practice action and an on-demand evidence view. Use a small allowlist of existing actionable detectors, version-aware recorded evidence, deterministic family/location deduplication and explicit single-lap versus repeated observations. Summarize the whole eligible session independently of comparison selection.

Reuse the existing feature package and application middleware, typed RPC, capture/alignment services, shared controls and localized messages. Keep UI and backend work independently implementable against one shared contract. Do not add AI, external baselines, new detectors, persisted summary tables or predicted gains.

## Rationale and consequences

Own-session analysis works without provider setup or a compatible reference lap. Deterministic selection is inspectable and avoids provider cost or generation variance. Fewer than three defensible findings produce fewer cards; missing location or telemetry must remain visible limitations. Fixed location buckets can split nearby events, and a practice suggestion is not proof of causality. Whole-session aggregation may be slower on an uncached large session; reuse existing caches and process captures sequentially rather than add speculative infrastructure.

## Plans

- [Shared contract, acceptance criteria and E2E scenarios](../plans/3-to-improve-contract.md)
- [UI implementation plan](../plans/3-to-improve-ui-plan.md)
- [Backend implementation plan](../plans/3-to-improve-backend-plan.md)

Implementation must wait for contract approval. Planning does not constitute implementation authorization or passing runtime evidence.
