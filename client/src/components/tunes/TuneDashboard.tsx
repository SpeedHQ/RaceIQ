import { useTelemetryStore } from "../../stores/telemetry";
import { useTrackName } from "../../hooks/queries";
import { AutoTunePanel } from "./AutoTunePanel";

/**
 * TuneDashboard — dedicated, tune-focused workspace (NOT embedded in the live
 * racing dashboard). Drives the symptom→intent→apply auto-tune pipeline off the
 * current/last session's recorded stints.
 */
export function TuneDashboard({ gameId }: { gameId: "acc" | "ac-evo" }) {
  const packet = useTelemetryStore((s) => s.packet);
  const sessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const { data: trackName } = useTrackName(packet?.TrackOrdinal);

  return (
    <div className="flex-1 overflow-y-auto">
      <AutoTunePanel gameId={gameId} laps={sessionLaps} trackName={trackName ?? undefined} />
    </div>
  );
}
