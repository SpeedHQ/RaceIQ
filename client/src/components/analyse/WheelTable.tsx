import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

interface WheelTableRow {
  id?: string;
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

function nodeSignature(value: ReactNode): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(nodeSignature).join("|");
  const element = value as ReactElement & { props?: { children?: ReactNode } };
  const type = typeof element.type === "string" ? element.type : typeof element.type === "function" ? element.type.name || "component" : "node";
  const childText = element.props?.children ? nodeSignature(element.props.children) : "";
  return `${type}:${childText}`;
}

function getRowKey(row: WheelTableRow, seen: Map<string, number>): string {
  const stableBase = row.id ?? [nodeSignature(row.label), row.span2 ? "span2" : "span4"].join("|");
  const count = seen.get(stableBase) ?? 0;
  seen.set(stableBase, count + 1);
  return `${stableBase}#${count}`;
}

export function WheelTable({ title, showHeaders = true, borderTop = false, rows }: WheelTableProps) {
  const headerContentClass = borderTop ? "block pt-2 border-t border-app-border" : undefined;
  const rowKeyState = new Map<string, number>();
  return (
    <Table className="w-auto table-fixed text-xs">
      <colgroup>
        <col className="w-[85px]" />
        <col />
        <col />
        <col />
        <col />
      </colgroup>
      {showHeaders && (
        <TableHeader>
          <TableRow>
            <TableHead>
              <span className={cn("block font-semibold uppercase tracking-wider", headerContentClass)}>{title}</span>
            </TableHead>
            <TableHead className="text-center">
              <span className={headerContentClass}>FL</span>
            </TableHead>
            <TableHead className="text-center">
              <span className={headerContentClass}>FR</span>
            </TableHead>
            <TableHead className="text-center">
              <span className={headerContentClass}>RL</span>
            </TableHead>
            <TableHead className="text-center">
              <span className={headerContentClass}>RR</span>
            </TableHead>
          </TableRow>
        </TableHeader>
      )}
      <TableBody>
        {rows.map((row) => {
          const key = getRowKey(row, rowKeyState);
          return (
            <TableRow key={key}>
              <TableCell className="text-app-text-secondary">{row.label}</TableCell>
              {row.span2 ? (
                <>
                  <TableCell className="text-right" colSpan={2}>
                    {row.fl}
                  </TableCell>
                  <TableCell className="text-right" colSpan={2}>
                    {row.rl}
                  </TableCell>
                </>
              ) : (
                <>
                  <TableCell className="text-right">{row.fl}</TableCell>
                  <TableCell className="text-right">{row.fr}</TableCell>
                  <TableCell className="text-right">{row.rl}</TableCell>
                  <TableCell className="text-right">{row.rr}</TableCell>
                </>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
