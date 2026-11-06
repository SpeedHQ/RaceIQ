---
name: raceiq-lmu-opponent-fixture-validation
description: Use when selecting RaceIQ LMU recordings for cold-load E2/E9; validate production-ready player and complete opponent interval before accepting fixture.
---

# LMU opponent fixture validation

Use for E2/E9 real-recording fixture selection.

- Read `docs/plans/lmu-opponent-cold-load-contract.md` first; preserve strict real-source acceptance and performance budgets.
- Candidate must produce, through production import/indexing, a source-backed valid player lap and at least one telemetry opponent interval with complete coverage. Sampled frames or fixture names are not proof.
- Use `readLmuOpponentColdLoadIdentity()` in `packages/game-lmu/test/support/opponent-cold-load-server.ts` as the identity gate. It verifies ready state, publication source revision/dependencies, player facts, and complete telemetry candidate.
- Run E2 alone after building assets. Run E9 separately against same qualifying source. Record measured evidence or exact pre-measurement failure.
- Keep E2/E9 test fixture selection separate from `LMU_MULTIPLAYER_FIXTURE_PARTS` if candidate differs; that constant also controls default `FIXTURES.lmu` seeding.
- Never synthesize laps, weaken completeness checks, or silently replace acceptance source. If repository candidates fail, request the user’s accessible recording path and leave acceptance blocked.
