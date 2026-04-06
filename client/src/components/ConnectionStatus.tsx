import { useTelemetryStore } from "../stores/telemetry";
import { useSettings } from "../hooks/queries";

interface Props {
  connected: boolean;
  packetsPerSec: number;
  forzaReceiving: boolean;
}

const GAME_LABELS: Record<string, string> = {
  "fm-2023": "Forza",
  "f1-2025": "F1 25",
  "acc": "ACC",
};

export function ConnectionStatus({ connected, packetsPerSec, forzaReceiving }: Props) {
  const packet = useTelemetryStore((s) => s.packet);
  const detectedGame = useTelemetryStore((s) => s.serverStatus?.detectedGame);
  const { displaySettings } = useSettings();

  // Active game label: prefer live packet gameId, fall back to detected running process
  const gameLabel = packet?.gameId
    ? (GAME_LABELS[packet.gameId] ?? packet.gameId)
    : detectedGame?.name ?? null;

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-app-surface">
      <div className="flex items-center gap-2 w-28 shrink-0">
        <div
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            connected ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" : "bg-red-500"
          }`}
        />
        <span className="text-sm font-medium text-app-text whitespace-nowrap">
          {connected ? "Server" : "Disconnected"}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            forzaReceiving
              ? "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.5)]"
              : gameLabel
                ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.3)]"
                : "bg-app-text-dim"
          }`}
        />
        <span className="text-sm font-medium text-app-text whitespace-nowrap">
          {forzaReceiving
            ? (gameLabel ?? "Receiving")
            : gameLabel
              ? `${gameLabel} — No Signal`
              : "No Signal"}
        </span>
      </div>
      <span className="text-sm text-app-text-muted font-mono tabular-nums whitespace-nowrap shrink-0">
        {forzaReceiving ? `${packetsPerSec} pkt/s · ${displaySettings.wsRefreshRate ?? 60}Hz` : ""}
      </span>
    </div>
  );
}
