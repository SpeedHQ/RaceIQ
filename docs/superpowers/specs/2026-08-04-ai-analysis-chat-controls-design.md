# AI Analysis and Chat Controls

## Scope

Apply consistent analysis-card and chat controls to both AI surfaces:

- Lap analysis page (`AiPanel`)
- Compare chat panel (`CompareAiPanel`)

## User experience

### Analysis cards

Each persisted analysis result has a refresh/regenerate icon and a bin icon beside it.

- Lap analysis bin deletes the stored lap analysis and clears its client state.
- Compare lap-card bins delete the corresponding stored lap analysis and clear its client state.
- Inputs Comparison bin deletes the stored inputs comparison analysis and clears its client state.
- Chat history is never deleted by analysis-card deletion.
- After deletion, the card returns to its pre-analysis state and its analyse button is available again.
- Refresh and delete controls are disabled while that analysis is running.

### Collapse and expand

The analysis-card region is collapsible on both surfaces.

- Default state is expanded.
- Expanded state shows the existing analysis cards/results.
- Collapsed state hides the cards and lets the actual chat consume the available panel height.
- Toggle has an accessible label and visible expand/collapse affordance.
- Collapse state is local UI state and does not change persisted analyses or chat history.

On the lap analysis page, the analysis result section collapses while the lap chat remains available. In Compare, all three cards (Lap A, Lap B, Inputs Comparison) collapse as one region while compare chat remains available.

### Clear chat

Both surfaces expose a clearly labelled **Clear chat** button in the chat header.

- Clears persisted chat messages, including chat generations according to existing endpoint semantics.
- Preserves every analysis result.
- Remounts the chat runtime so the empty state appears immediately.
- Does not delete or regenerate analysis data.

## Implementation boundaries

- Reuse existing `Trash2`, `RefreshCw`, and existing button styles.
- Keep analysis state and chat state independent.
- Add dedicated DELETE endpoints for stored lap and compare lap analyses because the current lap chat DELETE also clears lap analysis.
- Reuse the existing compare inputs DELETE endpoint and wire all analysis deletes to remove persisted records plus reset client state.
- Preserve existing analysis loading, error, modal, and chat-generation behavior.

## Verification

Verify both surfaces in the browser:

1. Generate/load analyses.
2. Delete each analysis type and confirm only that card resets.
3. Confirm chat remains intact after analysis deletion.
4. Collapse and expand analysis regions; confirm chat gains and releases space.
5. Clear chat; confirm chat empties while analysis cards remain.
6. Confirm refresh/delete/clear controls are unavailable during active work where applicable.
