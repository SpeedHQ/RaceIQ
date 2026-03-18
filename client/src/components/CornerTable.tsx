interface CornerDelta {
  label: string;
  deltaSeconds: number;
}

interface Props {
  corners: CornerDelta[];
}

export function CornerTable({ corners }: Props) {
  if (corners.length === 0) {
    return (
      <div className="text-slate-600 text-sm p-4">
        No corner data available.
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-slate-800">
            <th className="text-left p-2">Corner</th>
            <th className="text-right p-2">Delta</th>
          </tr>
        </thead>
        <tbody>
          {corners.map((c) => {
            const isGaining = c.deltaSeconds < 0;
            const isNeutral = Math.abs(c.deltaSeconds) < 0.005;
            const colorClass = isNeutral
              ? "text-slate-400"
              : isGaining
                ? "text-emerald-400"
                : "text-red-400";
            const sign = c.deltaSeconds > 0 ? "+" : "";

            return (
              <tr
                key={c.label}
                className="border-b border-slate-800/50 hover:bg-slate-800/30"
              >
                <td className="p-2 font-mono text-slate-300">{c.label}</td>
                <td className={`p-2 font-mono text-right ${colorClass}`}>
                  {sign}{c.deltaSeconds.toFixed(3)}s
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
