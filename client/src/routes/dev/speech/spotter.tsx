import { createFileRoute } from "@tanstack/react-router";
import { DevSpotterSpeechPanel } from "../../../components/dev/DevSpotterSpeechPanel";

export const Route = createFileRoute("/dev/speech/spotter")({
  component: DevSpotterSpeechPanel,
});
