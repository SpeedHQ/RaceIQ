import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { deltaColor } from "@/lib/colors";
import { COLOR_A, COLOR_B, formatSectionTime } from "@/lib/comparison-utils";
import { m } from "@/paraglide/messages";
import type { SegmentTiming } from "./CompareTrackMap";

export function CompareSegmentTable({ segments, tableRef }: { segments: SegmentTiming[]; tableRef: React.RefObject<HTMLTableSectionElement | null> }) {
  if (segments.length === 0) return null;
  return (
    <div className="min-h-24 flex-1 overflow-auto">
      <Table density="compact" fit variant="embedded">
        <THead>
          <TH>{m.compare_segment()}</TH>
          <TH align="end">
            <span style={{ color: COLOR_A }}>A</span>
          </TH>
          <TH align="end">
            <span style={{ color: COLOR_B }}>B</span>
          </TH>
          <TH align="end">+/-</TH>
        </THead>
        <TBody ref={tableRef}>
          {segments.map((s) => {
            const fasterA = s.timeA > 0 && s.timeB > 0 && s.timeA < s.timeB;
            const fasterB = s.timeA > 0 && s.timeB > 0 && s.timeB < s.timeA;
            const delta = s.timeA - s.timeB;
            const segmentDeltaColor = Math.abs(delta) < 0.005 ? "var(--app-text-secondary)" : deltaColor(delta);
            return (
              <TRow key={`${s.name}-${s.startFrac}-${s.endFrac}`}>
                <TD nowrap numeric tone="primary">
                  {s.name}
                </TD>
                <TD align="end" numeric tone={fasterA ? "success" : "default"}>
                  {formatSectionTime(s.timeA)}
                </TD>
                <TD align="end" numeric tone={fasterB ? "success" : "default"}>
                  {formatSectionTime(s.timeB)}
                </TD>
                <TD align="end" numeric>
                  <span style={{ color: segmentDeltaColor }}>{s.timeA > 0 && s.timeB > 0 ? `${delta > 0 ? "+" : ""}${delta.toFixed(3)}` : "-"}</span>
                </TD>
              </TRow>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
