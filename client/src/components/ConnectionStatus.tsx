interface Props {
  connected: boolean;
  packetsPerSec: number;
  forzaReceiving: boolean;
}

export function ConnectionStatus({ connected, packetsPerSec, forzaReceiving }: Props) {
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
      <div className="flex items-center gap-2 w-24 shrink-0">
        <div
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
            forzaReceiving
              ? "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.5)]"
              : "bg-app-text-dim"
          }`}
        />
        <span className="text-sm font-medium text-app-text whitespace-nowrap">
          {forzaReceiving ? "Forza" : "No Signal"}
        </span>
      </div>
      <span className="text-sm text-app-text-muted font-mono tabular-nums w-20 whitespace-nowrap shrink-0">
        {forzaReceiving ? `${packetsPerSec} pkt/s` : ""}
      </span>
    </div>
  );
}
