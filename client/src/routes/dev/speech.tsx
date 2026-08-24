import { createFileRoute } from "@tanstack/react-router";
import { DevLiveEngineerSpeechPanel } from "../../components/dev/DevLiveEngineerSpeechPanel";

export const Route = createFileRoute("/dev/speech")({
  component: DevLiveEngineerSpeechPanel,
});
