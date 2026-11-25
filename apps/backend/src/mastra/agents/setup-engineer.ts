import { createSetupEngineerAgent } from "@raceiq/assistant/mastra/agents/setup-engineer";
import { setupEngineerTools } from "../tools/setup-engineer";

export { buildSetupEngineerSystemPrompt, SETUP_ENGINEER_INSTRUCTIONS, type SetupEngineerSessionContext } from "@raceiq/assistant/mastra/agents/setup-engineer";
export const setupEngineerAgent = createSetupEngineerAgent(setupEngineerTools);
