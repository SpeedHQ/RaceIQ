import { m } from "../paraglide/messages";
import { Table } from "./ui/AppTable";

interface CornerDelta {
  label: string;
  deltaSeconds: number;
  timeA: number;
  timeB: number;
}

interface Props {
  corners: CornerDelta[];
}

export function CornerTable({ corners }: Props) {
  if (corners.length === 0) {
    return <div className="text-app-text-dim text-app-subtext p-4">{m.corner_no_data()}</div>;
  }

  return (
    <div className="overflow-auto">
      <Table fit tableClassName="w-full">
        <thead>
          <tr className="text-app-label text-app-text-muted uppercase tracking-wider border-b border-app-border">
            <th className="text-left p-2">{m.label_corner()}</th>
            <th className="text-right p-2">{m.label_delta()}</th>
          </tr>
        </thead>
        <tbody>
          {corners.map((c) => {
            const isGaining = c.deltaSeconds < 0;
            const isNeutral = Math.abs(c.deltaSeconds) < 0.005;
            const colorClass = isNeutral ? "text-app-text-secondary" : isGaining ? "text-(--delta-gain)" : "text-(--delta-loss)";
            const sign = c.deltaSeconds > 0 ? "+" : "";

            return (
              <tr key={c.label} className="border-b border-app-border/50 hover:bg-app-surface-hover/30">
                <td className="p-2 font-mono text-app-text">{c.label}</td>
                <td className={`p-2 font-mono text-right ${colorClass}`}>
                  {sign}
                  {c.deltaSeconds.toFixed(3)}s
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
