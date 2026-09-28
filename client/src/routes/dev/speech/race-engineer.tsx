import { createFileRoute } from "@tanstack/react-router";
import { DevRaceEngineerSpeechPanel } from "../../../components/dev/DevRaceEngineerSpeechPanel";

export const Route = createFileRoute("/dev/speech/race-engineer")({
  component: DevRaceEngineerSpeechPanel,
});
