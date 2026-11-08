---
description: Require every implementation plan to define acceptance criteria, edge cases and their solutions, and end-to-end validation of implementation.
alwaysApply: true
---

# Plan acceptance criteria, edge cases, and end-to-end validation

When creating or revising any implementation plan:

- MUST include explicit, observable acceptance criteria for every requested behavior. Assign stable identifiers so implementation tasks and verification can reference the same criteria.
- MUST identify relevant edge cases, boundary conditions, failure paths, and state transitions. For each case, document the expected behavior, the planned solution or handling strategy, and the acceptance criteria it affects. Do not merely list risks without explaining how the implementation will address them.
- MUST reference relevant existing contracts, specifications, or code when they define expected behavior. Shared definitions belong in their authoritative document rather than being duplicated across plans.
- MUST include an end-to-end test strategy that validates the implemented behavior through the actual application or system entry point and its affected integrations. Map each acceptance criterion and identified edge case to concrete E2E scenarios with setup, action, and observable expected results.
- MUST plan to reuse or extend the existing E2E suite where available. If no suitable E2E harness exists, include the minimal runnable E2E setup required for the changed path. Tests must be deterministic and isolated, with controlled data and dependencies where necessary; mocks must not replace the application integration being validated.
- Unit tests, component tests, static checks, builds, and mock-only tests MAY supplement E2E validation but MUST NOT substitute for it.
- MUST include executing the relevant E2E scenarios after implementation and recording their outcomes. Implementation completion requires all acceptance criteria and edge cases to be covered by passing E2E evidence; planned, skipped, blocked, or unexecuted tests are not proof of completion. Report any unavailable environment, dependency, or untestable requirement explicitly rather than claiming validation passed.
- When scope or expected behavior changes, MUST update the affected acceptance criteria, edge-case solutions, implementation tasks, and E2E scenarios together.

Apply these requirements to each separate implementation plan, including UI and backend plans. Cross-layer E2E scenarios may have one shared definition and execution owner, but each plan MUST explicitly reference that definition and map its own acceptance criteria and edge cases to the relevant scenarios. Preserve parallel implementation while making final integration validation an explicit completion dependency.

For planning-only requests, describe the required tests and evidence in the plan; do not claim they have run or execute implementation work without authorization.
