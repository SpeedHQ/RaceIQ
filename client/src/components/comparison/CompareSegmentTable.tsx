import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { deltaColor } from "@/lib/colors";
import { formatSectionTime } from "@/lib/comparison-utils";
import { m } from "@/paraglide/messages";

export interface SegmentTiming {
  name: string;
  type: "corner" | "straight";
  times: number[];
  startFrac: number;
  endFrac: number;
}

export interface SegmentLap {
  label: string;
  color: string;
}

export function compareSegmentKey(name: string, startFrac: number, endFrac: number): string {
  return `${name}:${startFrac}:${endFrac}`;
}

export function CompareSegmentTable({ segments, laps, tableRef }: { segments: SegmentTiming[]; laps: SegmentLap[]; tableRef: React.RefObject<HTMLTableSectionElement | null> }) {
  if (segments.length === 0 || laps.length === 0) return null;
  return (
    <div className="min-h-24 flex-1 overflow-auto">
      <Table density="compact" fit variant="embedded">
        <THead>
          <TH>{m.compare_segment()}</TH>
          {laps.map((lap, index) => (
            <TH key={`${lap.label}:${index}`} align="end">
              <span title={lap.label} style={{ color: lap.color }}>
                {String.fromCharCode(65 + index)}
                {index > 0 && " Δ"}
              </span>
            </TH>
          ))}
        </THead>
        <TBody ref={tableRef}>
          {segments.map((segment) => {
            const validTimes = segment.times.filter((time) => time > 0);
            const fastest = validTimes.length > 0 ? Math.min(...validTimes) : null;
            const referenceTime = segment.times[0] ?? 0;
            return (
              <TRow key={compareSegmentKey(segment.name, segment.startFrac, segment.endFrac)}>
                <TD nowrap numeric tone="primary">
                  {segment.name}
                </TD>
                {segment.times.map((time, index) => {
                  const delta = time > 0 && referenceTime > 0 ? time - referenceTime : null;
                  const color = delta == null || Math.abs(delta) < 0.005 ? "var(--app-text-secondary)" : deltaColor(delta);
                  return (
                    <TD key={`${segment.name}:${index}`} align="end" numeric tone={fastest != null && time === fastest ? "success" : "default"}>
                      <span>{formatSectionTime(time)}</span>
                      {index > 0 && (
                        <span className="ml-1 text-app-caption" style={{ color }}>
                          {delta == null ? "-" : `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`}
                        </span>
                      )}
                    </TD>
                  );
                })}
              </TRow>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
