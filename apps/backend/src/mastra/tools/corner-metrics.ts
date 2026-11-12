import { createCornerMetricsTool } from "@raceiq/assistant/mastra/tools/corner-metrics";
import { resolveLapCorners } from "../../tracks/corner-resolution";

export { cornerMatchesId } from "@raceiq/assistant/mastra/tools/corner-metrics";
export const getCornerMetricsTool = createCornerMetricsTool(resolveLapCorners);
