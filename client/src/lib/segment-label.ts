/**
 * Track segment display labels.
 *
 * The implementation lives in shared/ because the AI track-guide context
 * (server/ai/track-guides.ts) must name corners exactly the way the map does —
 * the analyst prompt whitelists corner labels, so a second spelling here would
 * let the guide coach names the prompt then rejects.
 */
// Relative, not "@shared/*": bun test resolves this file against the root
// tsconfig, whose `include` covers server/shared/test but not client/.
export { formatTurnNumbers, segmentDisplayName, segmentDisplayNames } from "../../../shared/segment-label";
