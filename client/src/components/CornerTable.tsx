import { m } from "../paraglide/messages";
import { Table, TBody, TD, TH, THead, TRow } from "./ui/AppTable";

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
      <Table fit>
        <THead>
          <TH>{m.label_corner()}</TH>
          <TH align="end">{m.label_delta()}</TH>
        </THead>
        <TBody>
          {corners.map((c) => {
            const isGaining = c.deltaSeconds < 0;
            const isNeutral = Math.abs(c.deltaSeconds) < 0.005;
            const colorClass = isNeutral ? "text-app-text-secondary" : isGaining ? "text-(--delta-gain)" : "text-(--delta-loss)";
            const sign = c.deltaSeconds > 0 ? "+" : "";

            return (
              <TRow key={c.label}>
                <TD tone="primary">{c.label}</TD>
                <TD align="end" numeric>
                  <span className={colorClass}>
                    {sign}
                    {c.deltaSeconds.toFixed(3)}s
                  </span>
                </TD>
              </TRow>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
