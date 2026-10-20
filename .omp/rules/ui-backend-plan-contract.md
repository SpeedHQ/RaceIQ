---
description: Require separate UI and backend implementation plans linked to one agreed Markdown contract whenever a plan includes both UI and backend changes.
alwaysApply: true
---

# UI and backend planning contract

When creating or revising a plan that includes both UI and backend changes:

- MUST create separate Markdown implementation plans for UI and backend work. A single combined implementation plan with UI and backend sections is not sufficient.
- MUST create or reuse one shared Markdown contract and agree its cross-boundary decisions before either implementation begins. Resolve decisions from approved requirements and existing repository contracts first; ask the user only about material unresolved tradeoffs. Do not claim agreement while decisions affecting either side remain unresolved.
- MUST link both implementation plans to the same contract using explicit relative Markdown links. The contract MUST link back to both plans.
- The contract MUST define the integration boundary at the level needed for independent implementation: operations or endpoints, request and response shapes, field types and semantics, required versus optional or nullable values, error behavior, and applicable authentication, pagination, ordering, or state-transition rules. Include representative examples and observable integration acceptance criteria where relevant; omit inapplicable sections.
- Each implementation plan MUST define its own scope, owned files or components, tasks, verification, and acceptance criteria against the shared contract. Reference shared definitions rather than duplicating them in either plan.
- MUST structure the plans so UI and backend implementation can proceed in parallel after contract agreement. UI development may use contract-conforming fixtures or mocks without waiting for backend completion; these MUST NOT replace the required production integration or remain as fake production fallbacks.
- MUST identify genuine shared prerequisites and integration work explicitly. Assign one owner for shared artifacts; do not invent dependencies that serialize otherwise independent implementation.
- Changes to the agreed boundary MUST update the shared contract and both affected plans, with affected implementers informed before dependent work continues. Neither side may silently diverge from the contract.
- Completion MUST include verification of the real UI/backend integration against the shared acceptance criteria; isolated mocks or separate component checks alone are insufficient.

Use repository planning conventions and existing artifact locations. If none exist, place `<feature>-contract.md`, `<feature>-ui-plan.md`, and `<feature>-backend-plan.md` together in the chosen planning directory. This rule does not require implementation, dispatch, or checkpoint creation when the user requests planning only.
