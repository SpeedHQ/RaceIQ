# Setup Engineer

Setup Engineer provides a persistent workspace for tuning one car at one track. Each experiment contains setup versions, associated laps, chat history, action history, and a current head version.

## Model

- An experiment is scoped to one game, car, and track.
- Setup versions form a forest. Base setups are roots; applied changes and branches create immutable descendants.
- ACC and AC Evo versions refer to setup files. F1 25 versions store telemetry-derived setup snapshots and present changes as values to enter in-game.
- Laps can be recorded during a deliberate run or imported from matching history. Imported laps may be assigned to a version or retained as experiment-level baseline data.
- Deleting a version moves its subtree to trash. Action history supports restoring and undoing mutations without deleting laps or setup files.

## Analysis flow

Each chat turn gathers deterministic context before invoking the agent:

1. Load current setup and version history.
2. Select valid, non-excluded laps and remove obvious time outliers.
3. Aggregate symptoms across clean laps.
4. Compute lap-time confidence and per-corner line, brake, and throttle consistency.
5. Add track conditions and lap provenance.
6. Invoke the Setup Engineer with action tools plus optional deep analysis tools.

Low-confidence data never blocks a recommendation. The response reports its limits, offers a caveated suggestion, or directs the driver to coaching when line and input variation indicate a driving problem rather than a setup problem.

## Safety boundaries

- Setup changes pass through game-specific rules and range clamps.
- File games resolve setup paths through guarded filesystem adapters.
- F1 setup changes remain advisory because RaceIQ cannot write them into the game.
- Lap exclusion is explicit and reversible.
- Mutating tools append action records used by the shared undo path.
- Missing or mixed-baseline data remains visible; it is not presented as branch-specific evidence.

## Primary implementation

- `mastra/workflows/setup-engineer-turn.ts`: prerequisite workflow
- `mastra/agents/setup-engineer.ts`: agent instructions and tool registration
- `mastra/tools/setup-engineer.ts`: experiment actions and optional analyses
- `server/experiments/lap-evidence/aggregate.ts`: lap selection and aggregate context
- `server/lap-analysis/consistency.ts`: per-corner consistency analysis
- `server/setups/io.ts`: file and snapshot setup adapters
- `server/experiment-undo.ts`: action reversal
- `server/db/experiment-action-queries.ts`: action history persistence

Current unresolved validation is tracked in [Setup Engineer status](../project-status/setup-engineer.md).
