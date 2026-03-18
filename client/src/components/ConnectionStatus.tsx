interface Props {
  connected: boolean;
  packetsPerSec: number;
}

export function ConnectionStatus({ connected, packetsPerSec }: Props) {
  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-slate-900 border-b border-slate-800">
      <div className="flex items-center gap-2">
        <div
          className={`w-2.5 h-2.5 rounded-full ${
            connected ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" : "bg-red-500"
          }`}
        />
        <span className="text-sm font-medium text-slate-300">
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>
      {connected && (
        <span className="text-sm text-slate-500">
          {packetsPerSec} pkt/s
        </span>
      )}
    </div>
  );
}
