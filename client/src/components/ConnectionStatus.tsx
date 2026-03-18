interface Props {
  connected: boolean;
  packetsPerSec: number;
  forzaReceiving: boolean;
}

export function ConnectionStatus({ connected, packetsPerSec, forzaReceiving }: Props) {
  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-slate-900">
      <div className="flex items-center gap-2">
        <div
          className={`w-2.5 h-2.5 rounded-full ${
            connected ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" : "bg-red-500"
          }`}
        />
        <span className="text-sm font-medium text-slate-300">
          {connected ? "Server" : "Disconnected"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div
          className={`w-2.5 h-2.5 rounded-full ${
            forzaReceiving
              ? "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.5)]"
              : "bg-slate-600"
          }`}
        />
        <span className="text-sm font-medium text-slate-300">
          {forzaReceiving ? "Forza" : "No Signal"}
        </span>
      </div>
      {forzaReceiving && (
        <span className="text-sm text-slate-500 font-mono">
          {packetsPerSec} pkt/s
        </span>
      )}
    </div>
  );
}
