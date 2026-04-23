import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg ${className}`}>
      <table className="w-full text-sm">
        {children}
      </table>
    </div>
  );
}

export function THead({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <thead className={`bg-app-surface sticky top-0 z-10 ${className}`}>
      <tr className="text-[10px] uppercase tracking-wider text-app-text-muted border-b border-app-border">
        {children}
      </tr>
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-app-border/40">{children}</tbody>;
}

export function TRow({
  children,
  className = "",
  onClick,
  onContextMenu,
  title,
  style,
  tooltip,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
  style?: React.CSSProperties;
  tooltip?: string;
}) {
  return (
    <tr
      className={`group/row relative hover:bg-app-surface/50 transition-colors ${onClick ? "cursor-pointer" : ""} ${className}`}
      onClick={onClick}
      title={title}
      style={style}
      onContextMenu={onContextMenu}
    >
      {children}
      {tooltip && (
        <td className="p-0 w-0 overflow-visible">
          <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 hidden group-hover/row:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-[11px] text-app-text-secondary z-50 whitespace-nowrap">
            {tooltip}
          </span>
        </td>
      )}
    </tr>
  );
}

export function TH({
  children,
  className = "",
  ...props
}: { children?: ReactNode; className?: string } & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={`px-3 py-2 text-left ${className}`} {...props}>
      {children}
    </th>
  );
}

export function TD({
  children,
  className = "",
  ...props
}: { children?: ReactNode; className?: string } & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`px-3 py-2 ${className}`} {...props}>
      {children}
    </td>
  );
}
