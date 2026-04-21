import { useTelemetryStore } from "../stores/telemetry";
import { useSettings } from "../hooks/queries";
import { deriveConnectionStatusView } from "./connection-status-logic";

interface Props {
  connected: boolean;
  packetsPerSec: number;
  forzaReceiving: boolean;
}

const DOT_CLASS: Record<"green" | "red" | "cyan" | "amber" | "dim", string> = {
  green: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]",
  red: "bg-red-500",
  cyan: "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.5)]",
  amber: "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.3)]",
  dim: "bg-app-text-dim",
};

export function ConnectionStatus({ connected, packetsPerSec, forzaReceiving }: Props) {
  const detectedGame = useTelemetryStore((s) => s.serverStatus?.detectedGame);
  const { displaySettings } = useSettings();
  const view = deriveConnectionStatusView({ connected, forzaReceiving, detectedGame });

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-app-surface">
      <div className="flex items-center gap-2 w-28 shrink-0">
        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${connected ? DOT_CLASS.green : DOT_CLASS.red}`} />
        <span className="text-sm font-medium text-app-text whitespace-nowrap">{view.serverLabel}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${DOT_CLASS[view.dotColor]}`} />
        <span className="text-sm font-medium text-app-text whitespace-nowrap">{view.gameText}</span>
      </div>
      <span className="text-sm text-app-text-muted font-mono tabular-nums whitespace-nowrap shrink-0">
        {forzaReceiving ? `${packetsPerSec} pkt/s · ${displaySettings.wsRefreshRate ?? 60}Hz` : ""}
      </span>
    </div>
  );
}
