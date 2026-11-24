import { createDriverCoachAgent } from "@raceiq/assistant/mastra/agents/driver-coach";
import { driverCoachTools } from "../tools/driver-coach";

export { buildDriverCoachInstructions, DRIVER_COACH_INSTRUCTIONS } from "@raceiq/assistant/mastra/agents/driver-coach";
export const driverCoachAgent = createDriverCoachAgent(driverCoachTools);
