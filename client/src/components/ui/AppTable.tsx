import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg overflow-x-auto ${className}`}>
      <table className="w-full text-sm">
        {children}
      </table>
    </div>
  );
}

export function THead({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <thead className={className}>
      <tr className="text-[10px] uppercase tracking-wider text-app-text-muted border-b border-app-border bg-app-surface">
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
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <tr
      className={`hover:bg-app-surface/50 transition-colors ${onClick ? "cursor-pointer" : ""} ${className}`}
      onClick={onClick}
    >
      {children}
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
