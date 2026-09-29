import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deltaColor } from "@/lib/colors";
import { COLOR_A, COLOR_B, compareSegmentKey, formatSectionTime } from "@/lib/comparison-utils";
import { m } from "@/paraglide/messages";
import type { SegmentTiming } from "./CompareTrackMap";

export function CompareSegmentTable({ segments, tableRef }: { segments: SegmentTiming[]; tableRef: React.RefObject<HTMLTableSectionElement | null> }) {
  if (segments.length === 0) return null;
  return (
    <div className="min-h-24 flex-1 overflow-auto">
      <Table className="w-full text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>{m.compare_segment()}</TableHead>
            <TableHead className="text-right">
              <span style={{ color: COLOR_A }}>A</span>
            </TableHead>
            <TableHead className="text-right">
              <span style={{ color: COLOR_B }}>B</span>
            </TableHead>
            <TableHead className="text-right">+/-</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody ref={tableRef}>
          {segments.map((s) => {
            const fasterA = s.timeA > 0 && s.timeB > 0 && s.timeA < s.timeB;
            const fasterB = s.timeA > 0 && s.timeB > 0 && s.timeB < s.timeA;
            const delta = s.timeA - s.timeB;
            const segmentDeltaColor = Math.abs(delta) < 0.005 ? "var(--app-text-secondary)" : deltaColor(delta);
            return (
              <TableRow key={compareSegmentKey(s.name, s.startFrac, s.endFrac)}>
                <TableCell className="whitespace-nowrap font-mono font-medium">{s.name}</TableCell>
                <TableCell className={`text-right font-mono tabular-nums ${fasterA ? "text-[var(--status-success)]" : ""}`}>{formatSectionTime(s.timeA)}</TableCell>
                <TableCell className={`text-right font-mono tabular-nums ${fasterB ? "text-[var(--status-success)]" : ""}`}>{formatSectionTime(s.timeB)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  <span style={{ color: segmentDeltaColor }}>{s.timeA > 0 && s.timeB > 0 ? `${delta > 0 ? "+" : ""}${delta.toFixed(3)}` : "-"}</span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
