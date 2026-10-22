# Combo strategy backend plan

Authoritative [shared contract](combo-strategy-contract.md); reciprocal [UI plan](combo-strategy-ui-plan.md). Coordinator owns shared schemas and final E2E; backend/UI proceed in parallel against the agreed contract.

## Scope and tasks

Own `packages/race-strategy/server/race-plan-{queries,routes}.ts`, server index exports as needed, `server/db/{migrations,schema}.ts`, and feature integration tests for active-plan API/persistence. Read current migration ordering/version conventions first. Add a new atomic migration from global singleton to composite-key pin table, preserve original pin, remove old table/schema and all server singleton queries. Implement getActiveRacePlans, exact-tuple setActiveRacePlan, delete/unload isolation, wrong-combo rejection, and clear old pin when selected plan identity changes. Migrate server tests and SQL assertions to new contract. Do not edit shared race-plan schemas or UI/host/stories.

## Acceptance/edge handling

Own C1/C3, support C2: exact validated tuple, missing ID 404, wrong tuple 400/no writes, independent pins, one pin per combo, identity-changing edit clears only prior pin, delete cascade, startup upgrade preserving singleton selection. Preserve auth, transactions and evidence rules. PI stays a live applicability rule rather than additional pin key. No session key. Contract fixtures may support independent UI development but are not production substitutes.

## Verification

Coordinator runs full affected integration test modules and shared E-C1/E-C2/E-C3. Migration test uses actual startup on isolated legacy schema, not a mocked DB. Confirm restart durability and old-code cutover search. Record passing/failing/blocked outcomes in contract; tests not run by worker. Worker skips builds/tests/lint/formatters; no stage/commit/delegation/checkpoint edits.
