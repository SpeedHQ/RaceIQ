import { createFileRoute } from "@tanstack/react-router";
import { DevLiveEngineerReplay } from "../../../components/dev/DevLiveEngineerReplay";

export const Route = createFileRoute("/dev/speech/engineer-replay")({
  validateSearch: (search: Record<string, unknown>) => ({
    gameId: typeof search.gameId === "string" ? search.gameId : undefined,
    sessionId: typeof search.sessionId === "number" || typeof search.sessionId === "string" ? Number(search.sessionId) : undefined,
    scenario: typeof search.scenario === "string" ? search.scenario : undefined,
  }),
  component: DevLiveEngineerReplay,
});
