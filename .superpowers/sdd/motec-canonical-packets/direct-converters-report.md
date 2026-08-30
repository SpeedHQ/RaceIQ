# Direct converters

Changed:
- `server/games/acc/motec.ts`: removed shared-memory/BIN synthesis; added direct `convertAccMotecToPackets` canonical packet mapping and retained ACC identity resolver.
- `server/motec/kunos-synthesis.ts`: added profile-aware preparation signature while preserving existing preparation behavior.

Commit: `ee074364a` (`refactor(acc): convert MoTeC logs to packets`).

Verification: shard check passed during pre-commit; client lint hook timed out after 30s. Focused tests/typecheck not run because target/loader pipeline remains concurrently incomplete.

Concern: AC Evo direct converter remains to be completed by integration owner; existing AC Evo helper implementation is still BIN-based.
