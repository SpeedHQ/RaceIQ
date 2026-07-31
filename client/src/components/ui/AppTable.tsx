import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

type TableProps = TableHTMLAttributes<HTMLTableElement> & {
  fit?: boolean;
  tableClassName?: string;
};

export function Table({ children, className, fit = false, tableClassName, ...props }: TableProps) {
  return (
    <div className={cn("rounded-lg", fit ? "" : "overflow-x-auto", className)}>
      <table className={cn("w-full text-sm", fit ? "min-w-0" : "min-w-max md:min-w-0", tableClassName)} {...props}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children, className, rowClassName, ...props }: HTMLAttributes<HTMLTableSectionElement> & { rowClassName?: string }) {
  return (
    <thead className={cn("bg-app-surface sticky top-0 z-10", className)} {...props}>
      <tr className={cn("text-app-caption uppercase tracking-wider text-app-text-muted border-b border-app-border", rowClassName)}>{children}</tr>
    </thead>
  );
}

export function TBody({ children, className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn("divide-y divide-app-border/40", className)} {...props}>
      {children}
    </tbody>
  );
}

export function TRow({
  children,
  className,
  tooltip,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & {
  tooltip?: string;
}) {
  return (
    <tr className={cn("group/row relative hover:bg-app-surface-hover/50 transition-colors", props.onClick && "cursor-pointer", className)} {...props}>
      {children}
      {tooltip && (
        <td className="p-0 w-0 overflow-visible">
          <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 hidden group-hover/row:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1 text-app-compact text-app-text-secondary z-50 whitespace-nowrap">
            {tooltip}
          </span>
        </td>
      )}
    </tr>
  );
}

export function TH({ children, className, ...props }: { children?: ReactNode; className?: string } & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={cn("px-3 py-2 text-left", className)} {...props}>
      {children}
    </th>
  );
}

export function TD({ children, className, ...props }: { children?: ReactNode; className?: string } & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("px-3 py-2", className)} {...props}>
      {children}
    </td>
  );
}

export const TableHeader = THead;
export const TableBody = TBody;
export const TableRow = TRow;
export const TableHead = TH;
export const TableCell = TD;
