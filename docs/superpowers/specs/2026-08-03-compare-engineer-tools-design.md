# Compare Engineer Tool Access

## Goal

Give the structured Compare Engineer agent read-only access to the same comparison and lap-inspection tools available to Compare Chat, without granting setup or driver-state mutation tools.

## Scope

Register these tools on `mastra/agents/compare-engineer.ts`:

### Comparison context

- `get_track_guide`
- `list_track_guides`
- `compare_f1_setup_to_catalog`
- `get_corner_metrics`

### Lap inspection

- `list_laps`
- `get_lap_detail`
- `get_lap_issues`
- `compare_laps`

No mutation tools are exposed: no setup changes, version deletion, exclusions, notes, drills, or driver records.

## Data flow

1. `/api/laps/:id1/compare/:id2/inputs-analyse` continues to build and provide its existing inline comparison prompt.
2. `compareEngineerAgent.generate()` receives the registered read-only tools.
3. The agent may call tools when inline context is insufficient or the requested analysis needs adjacent-lap, corner, issue, or guide data.
4. Tool results feed the same `InputsCompareSchema` structured response.
5. Existing caching, provider selection, and response parsing remain unchanged.

The generation call will use a bounded tool-step limit sufficient for read-only lookup followed by one final structured response. The inline prompt remains the default fast path.

## Error handling

Existing tool errors remain agent-visible and must not grant fallback mutation access. If a tool cannot answer, the agent must produce the existing schema-constrained response from available inline context. Existing route-level provider, parsing, and HTTP error handling remain unchanged.

## Verification

- Add focused coverage that confirms Compare Engineer exposes all eight selected tools and no mutation tools.
- Exercise `/api/laps/:id1/compare/:id2/inputs-analyse` with a prompt that requires a lap lookup.
- Confirm the response includes a tool call/result and still parses as valid `InputsCompareSchema` output.
- Run the focused comparison/agent tests; do not alter unrelated chat systems.
