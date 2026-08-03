# Lap Analysis Generation Tool

## Goal

Let analysis-aware agents generate the same persisted lap analysis produced by the existing `/api/laps/:id/analyse` flow, when they need context and no valid cached result exists.

## Behavior

Add a Mastra `generate_lap_analysis` tool with input `{ lapId: positive integer }` and optional `{ regenerate?: boolean }`.

- Reuse a valid cached analysis by default.
- Generate when cache is missing or invalid.
- Regenerate and overwrite cache only when `regenerate` is true.
- Return the same structured analysis JSON, usage metadata, cache status, and a readable representation as the existing analysis flow.
- Never save malformed or schema-invalid model output.
- Tool result remains visible in chat as a tool-result part.

## Shared implementation

Extract the existing analysis generation path into a server service used by both the HTTP route and the tool. The service owns:

- lap and telemetry validation;
- corner/segment/sector context construction;
- linked tune and F1 setup context;
- provider credentials and model selection;
- `lapAnalystAgent.generate` with the existing schema/provider options;
- JSON extraction and `getAnalystJsonSchema()` validation;
- `saveAnalysis` persistence and usage metadata.

The HTTP route retains its existing NDJSON heartbeat transport and response shape. The tool calls the service directly and does not make an HTTP self-request.

## Registration and grounding

Register the generation tool on Lap Chat, Compare Chat, and Compare Engineer alongside `get_lap_analysis`. Agent instructions must prefer `get_lap_analysis`; if unavailable, call `generate_lap_analysis`, then use the returned result. If generation fails, state the limitation and do not invent lap-specific findings.

The Lap Analyst agent itself is not given this tool; it is the generator, preventing recursive generation.

## Error handling

Return explicit unavailable/error tool results for missing laps, empty telemetry, unavailable provider credentials, model failures, invalid JSON, and schema failures. Preserve existing HTTP status/error behavior. Do not overwrite a valid cache on failed regeneration.

## Verification

- Service tests cover valid-cache reuse, missing-cache generation, explicit regeneration, malformed output, schema-invalid output, and persistence behavior.
- Agent registration tests cover all three consumers and confirm Lap Analyst is not recursive.
- Route tests or smoke checks confirm HTTP Analyse and tool generation use the same service.
- Tool smoke verifies returned analysis and visible tool-result stream data where the configured model is available.
