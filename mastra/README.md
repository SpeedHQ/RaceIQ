# Mastra

Mastra composition for RaceIQ AI agents, deterministic prerequisite workflows, model tools, evaluations, and development observability.

## Structure

- `index.ts` registers agents, workflows, scorers, storage, logging, and observability.
- `agents/` defines one agent per user-facing analysis or coaching role.
- `tools/` exposes bounded reads and actions over RaceIQ domains. `setup-engineer.ts` binds session and game identity through request context rather than model-supplied arguments.
- `workflows/` gathers deterministic prerequisites before model reasoning. `setup-engineer-turn.ts` assembles setup, experiment, clean-lap, quality, and version evidence.
- `evals/` owns model-backed fixtures and scorers.
- `model.ts` resolves configured model providers.

## Boundaries and invariants

Mastra orchestrates domain APIs; it does not own telemetry parsing, lap quality policy, experiment curation, setup rules, persistence, or HTTP validation. Import those contracts from their existing shared or server owners instead of duplicating them in tools or prompts.

Setup conclusions use shared `setup-analysis` and related lap eligibility decisions. Tools and workflows preserve exact eligibility status and reason codes in gathered context; `unknown` and `ineligible` evidence cannot support a setup conclusion. Manual experiment exclusion, policy rejection, and fastest-lap caps remain separate concepts.

Per-turn game and session identity comes from trusted request context. Models may choose supported actions and action arguments, but may not choose persistence scope. Keep read-before-reason workflows deterministic and action tools guarded by existing setup and experiment services.

`index.ts` is used by server chat routes and development Studio integration. Production imports remain environment-gated, and DuckDB observability keeps one writer.

## Testing

Use focused prompt, tool, workflow, and setup-engineer guard tests. Assert observable tool results, eligibility rejection, request-context scoping, and side-effect guards rather than Mastra implementation details.
