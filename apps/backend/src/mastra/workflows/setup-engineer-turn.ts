import { createSetupEngineerTurnWorkflow } from "@raceiq/assistant/mastra/workflows/setup-engineer-turn";
import { loadCleanLapAggregate } from "../../experiments/lap-evidence/aggregate";
import { readSetupEngineerContext } from "../tools/setup-engineer-request-context";

export const setupEngineerTurnWorkflow = createSetupEngineerTurnWorkflow({ readSetupEngineerContext, loadCleanLapAggregate });
