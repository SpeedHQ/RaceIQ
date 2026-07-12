import type { F1ExtendedData } from "@shared/types";

const COMPOUND_DOT: Record<string, string> = {
  soft: "bg-red-500",
  medium: "bg-yellow-400",
  hard: "bg-white",
  inter: "bg-green-500",
  wet: "bg-blue-500",
  unknown: "bg-zinc-600",
};

function formatGap(gap: number): string {
  if (gap === 0) return "-";
  if (gap < 0) return `-${Math.abs(gap).toFixed(1)}`;
  return `+${gap.toFixed(1)}`;
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return "-";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

export function F1GridTable({ f1, playerCarIndex }: { f1: F1ExtendedData; playerCarIndex?: number }) {
  const sorted = [...f1.grid].sort((a, b) => a.position - b.position);

  return (
    <div className="rounded-lg bg-zinc-900 overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-800">
        <span className="text-xs text-zinc-400 font-medium">
          Live Standings &mdash; {f1.sessionType?.replace("-", " ").toUpperCase() ?? "SESSION"}
          {f1.totalLaps > 0 && ` (${f1.totalLaps} laps)`}
        </span>
      </div>
      <div className="overflow-y-auto max-h-[400px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-900">
            <tr className="text-zinc-500 border-b border-zinc-800">
              <th className="px-2 py-1 text-left w-8">P</th>
              <th className="px-2 py-1 text-left">Driver</th>
              <th className="px-2 py-1 text-right">Gap</th>
              <th className="px-2 py-1 text-right">Int</th>
              <th className="px-2 py-1 text-right">Best</th>
              <th className="px-2 py-1 text-center w-6">T</th>
              <th className="px-2 py-1 text-right w-8">Age</th>
              <th className="px-2 py-1 text-center w-8">Pit</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => {
              const isPlayer = entry.name !== "" && playerCarIndex !== undefined;
              const dotColor = COMPOUND_DOT[entry.tyreCompound] ?? COMPOUND_DOT.unknown;
              return (
                <tr key={entry.position} className={`border-b border-zinc-800/50 hover:bg-zinc-800/50 ${isPlayer ? "" : ""}`}>
                  <td className="px-2 py-1 font-bold text-zinc-300">{entry.position}</td>
                  <td className="px-2 py-1 text-zinc-200 truncate max-w-[120px]">{entry.name || `Car ${entry.position}`}</td>
                  <td className="px-2 py-1 text-right text-zinc-400 tabular-nums">{entry.position === 1 ? "LEADER" : formatGap(entry.gapToLeader)}</td>
                  <td className="px-2 py-1 text-right text-zinc-400 tabular-nums">{formatGap(entry.gapToCarAhead)}</td>
                  <td className="px-2 py-1 text-right text-zinc-300 tabular-nums">{formatTime(entry.bestLapTime)}</td>
                  <td className="px-2 py-1 text-center">
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor}`} />
                  </td>
                  <td className="px-2 py-1 text-right text-zinc-500 tabular-nums">{entry.tyreAge}</td>
                  <td className="px-2 py-1 text-center text-zinc-500">{entry.pitStatus === 1 ? "IN" : entry.pitStatus === 2 ? "PIT" : entry.numPitStops > 0 ? entry.numPitStops : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
