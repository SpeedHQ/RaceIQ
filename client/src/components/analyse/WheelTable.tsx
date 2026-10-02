import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";

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
  const headerContentClass = borderTop ? "block border-t border-app-border pt-2" : undefined;
  const rowKeyState = new Map<string, number>();
  return (
    <table className="w-full min-w-0 table-fixed font-mono text-app-compact">
      <colgroup>
        <col className="w-[85px]" />
        <col />
        <col />
        <col />
        <col />
      </colgroup>
      {showHeaders && (
        <thead className="sticky top-0 z-10 bg-app-surface">
          <tr className="text-app-label text-app-text-muted uppercase tracking-wider">
            <th scope="col" className="p-0 text-left">
              <span className={cn("block font-semibold", headerContentClass)}>{title}</span>
            </th>
            {(["FL", "FR", "RL", "RR"] as const).map((wheel) => (
              <th key={wheel} scope="col" className="p-0 text-right">
                <span className={headerContentClass}>{wheel}</span>
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((row) => {
          const key = getRowKey(row, rowKeyState);
          return (
            <tr key={key}>
              <td className="p-0 text-app-text-secondary">{row.label}</td>
              {row.span2 ? (
                <>
                  <td className="p-0 text-right" colSpan={2}>{row.fl}</td>
                  <td className="p-0 text-right" colSpan={2}>{row.rl}</td>
                </>
              ) : (
                <>
                  <td className="p-0 text-right">{row.fl}</td>
                  <td className="p-0 text-right">{row.fr}</td>
                  <td className="p-0 text-right">{row.rl}</td>
                  <td className="p-0 text-right">{row.rr}</td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
