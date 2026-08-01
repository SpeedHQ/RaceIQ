import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/AppTable";

interface WheelTableRow {
  label: ReactNode;
  fl: ReactNode;
  fr: ReactNode;
  rl: ReactNode;
  rr: ReactNode;
  /** Optional: colspan the 4 cells into 2 pairs */
  span2?: boolean;
}

interface WheelTableProps {
  /** Section title shown in header row's label column */
  title?: ReactNode;
  /** Show FL/FR/RL/RR headers (default true) */
  showHeaders?: boolean;
  /** Whether to render border-t on header row */
  borderTop?: boolean;
  rows: WheelTableRow[];
}

export function WheelTable({ title, showHeaders = true, borderTop = false, rows }: WheelTableProps) {
  const headerContentClass = borderTop ? "block pt-2 border-t border-app-border" : undefined;
  return (
    <Table density="telemetry" fit variant="embedded">
      <colgroup>
        <col className="w-[85px]" />
        <col />
        <col />
        <col />
        <col />
      </colgroup>
      {showHeaders && (
        <TableHeader>
          <TableHead>
            <span className={cn("block text-app-caption font-semibold uppercase tracking-wider", headerContentClass)}>{title}</span>
          </TableHead>
          <TableHead align="end">
            <span className={headerContentClass}>FL</span>
          </TableHead>
          <TableHead align="end">
            <span className={headerContentClass}>FR</span>
          </TableHead>
          <TableHead align="end">
            <span className={headerContentClass}>RL</span>
          </TableHead>
          <TableHead align="end">
            <span className={headerContentClass}>RR</span>
          </TableHead>
        </TableHeader>
      )}
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i}>
            <TableCell tone="muted">{row.label}</TableCell>
            {row.span2 ? (
              <>
                <TableCell align="end" colSpan={2}>
                  {row.fl}
                </TableCell>
                <TableCell align="end" colSpan={2}>
                  {row.rl}
                </TableCell>
              </>
            ) : (
              <>
                <TableCell align="end">{row.fl}</TableCell>
                <TableCell align="end">{row.fr}</TableCell>
                <TableCell align="end">{row.rl}</TableCell>
                <TableCell align="end">{row.rr}</TableCell>
              </>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
