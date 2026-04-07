import type { ReactNode } from "react";

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
  const borderCls = borderTop ? "pt-2 border-t border-app-border" : "";
  return (
    <table className="w-full tabular-nums table-fixed text-[11px] font-mono">
      <colgroup>
        <col className="w-[85px]" />
        <col /><col /><col /><col />
      </colgroup>
      {showHeaders && (
        <thead>
          <tr className="text-app-text-muted">
            <th className={`font-semibold text-left text-[10px] uppercase tracking-wider ${borderCls}`}>{title}</th>
            <th className={`font-normal text-right ${borderCls}`}>FL</th>
            <th className={`font-normal text-right ${borderCls}`}>FR</th>
            <th className={`font-normal text-right ${borderCls}`}>RL</th>
            <th className={`font-normal text-right ${borderCls}`}>RR</th>
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            <td className="text-app-text-muted text-left">{row.label}</td>
            {row.span2 ? (
              <>
                <td colSpan={2} className="text-right">{row.fl}</td>
                <td colSpan={2} className="text-right">{row.rl}</td>
              </>
            ) : (
              <>
                <td className="text-right">{row.fl}</td>
                <td className="text-right">{row.fr}</td>
                <td className="text-right">{row.rl}</td>
                <td className="text-right">{row.rr}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
