import type { ReactNode } from "react";
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
  return (
    <Table fit className="rounded-none overflow-visible" tableClassName="w-full tabular-nums table-fixed text-app-compact font-mono">
      <colgroup>
        <col className="w-[85px]" />
        <col />
        <col />
        <col />
        <col />
      </colgroup>
      {showHeaders && (
        <TableHeader rowClassName="text-app-text-muted border-0">
          <TableHead className={`p-0 font-semibold text-left text-app-caption uppercase tracking-wider ${borderCls}`}>{title}</TableHead>
          <TableHead className={`p-0 font-normal text-right ${borderCls}`}>FL</TableHead>
          <TableHead className={`p-0 font-normal text-right ${borderCls}`}>FR</TableHead>
          <TableHead className={`p-0 font-normal text-right ${borderCls}`}>RL</TableHead>
          <TableHead className={`p-0 font-normal text-right ${borderCls}`}>RR</TableHead>
        </TableHeader>
      )}
      <TableBody className="divide-y-0">
        {rows.map((row, i) => (
          <TableRow key={i} className="hover:bg-transparent transition-none">
            <TableCell className="p-0 text-app-text-muted text-left">{row.label}</TableCell>
            {row.span2 ? (
              <>
                <TableCell colSpan={2} className="p-0 text-right">
                  {row.fl}
                </TableCell>
                <TableCell colSpan={2} className="p-0 text-right">
                  {row.rl}
                </TableCell>
              </>
            ) : (
              <>
                <TableCell className="p-0 text-right">{row.fl}</TableCell>
                <TableCell className="p-0 text-right">{row.fr}</TableCell>
                <TableCell className="p-0 text-right">{row.rl}</TableCell>
                <TableCell className="p-0 text-right">{row.rr}</TableCell>
              </>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
