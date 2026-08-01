import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

type LockedStyleProps<T> = Omit<T, "className" | "style"> & {
  className?: never;
  style?: never;
};

type RuntimeStyleOverrides = {
  className?: unknown;
  rowClassName?: unknown;
  style?: unknown;
  tableClassName?: unknown;
};

type TableProps = LockedStyleProps<ComponentPropsWithRef<"table">> & {
  density?: "default" | "compact" | "telemetry";
  fit?: boolean;
  layout?: "auto" | "fixed";
  variant?: "default" | "settings" | "embedded";
};

type THeadProps = LockedStyleProps<ComponentPropsWithRef<"thead">>;
type TBodyProps = LockedStyleProps<ComponentPropsWithRef<"tbody">>;
type TRowProps = LockedStyleProps<ComponentPropsWithRef<"tr">> & {
  selected?: boolean;
  tooltip?: string;
  variant?: "default" | "separator" | "static";
};
type CellAlign = "start" | "center" | "end";
type CellTone = "default" | "primary" | "muted" | "dim" | "accent" | "success" | "warning" | "danger" | "best";
type TruncateWidth = "narrow" | "wide";
type THProps = Omit<LockedStyleProps<ComponentPropsWithRef<"th">>, "align"> & {
  align?: CellAlign;
  nowrap?: boolean;
  showFrom?: "sm";
  sticky?: "start";
  visuallyHidden?: boolean;
};
type SortableTHProps = Omit<THProps, "aria-sort" | "children" | "onClick" | "onKeyDown" | "tabIndex"> & {
  children: ReactNode;
  direction?: "ascending" | "descending";
  onSort: () => void;
};
type TDProps = Omit<LockedStyleProps<ComponentPropsWithRef<"td">>, "align"> & {
  align?: CellAlign;
  emphasis?: boolean;
  numeric?: boolean;
  nowrap?: boolean;
  showFrom?: "sm";
  sticky?: "start";
  tone?: CellTone;
  truncate?: TruncateWidth;
};

const alignClasses: Record<CellAlign, string> = {
  start: "text-left",
  center: "text-center",
  end: "text-right",
};

const toneClasses: Record<CellTone, string> = {
  default: "text-app-text-secondary",
  primary: "text-app-text",
  muted: "text-app-text-muted",
  dim: "text-app-text-dim",
  accent: "text-app-accent",
  success: "text-status-success",
  warning: "text-status-warning",
  danger: "text-status-danger",
  best: "text-(--lap-pace-best)",
};

export function Table(inputProps: TableProps) {
  const {
    children,
    className: consumerClassName,
    density = "default",
    fit = false,
    layout = "auto",
    style: consumerStyle,
    tableClassName,
    variant = "default",
    ...props
  } = inputProps as TableProps & RuntimeStyleOverrides;
  void consumerClassName;
  void consumerStyle;
  void tableClassName;

  const variantClasses = {
    default: "",
    settings: "bg-app-surface/40 ring-1 ring-app-border",
    embedded: "rounded-none",
  } as const;
  const densityClasses = {
    default: "",
    compact: "text-app-compact [&_th]:px-2 [&_th]:py-1.5 [&_td]:px-2 [&_td]:py-1.5",
    telemetry: "table-fixed font-mono text-app-compact [&_th]:p-0 [&_td]:p-0 [&_tbody]:divide-y-0 [&_tbody>tr]:hover:bg-transparent [&_thead>tr]:border-0",
  } as const;

  return (
    <div data-slot="table-container" className={cn("rounded-lg", variantClasses[variant], fit ? "" : "overflow-x-auto")}>
      <table
        {...props}
        data-density={density}
        data-slot="table"
        data-variant={variant}
        className={cn(
          "w-full text-app-detail [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-app-surface [&_thead>tr]:border-b [&_thead>tr]:border-app-border [&_thead>tr]:text-app-label [&_thead>tr]:uppercase [&_thead>tr]:tracking-wider [&_thead>tr]:text-app-text-muted [&_tbody]:divide-y [&_tbody]:divide-app-border/40",
          fit ? "min-w-0" : "min-w-max md:min-w-0",
          layout === "fixed" && "table-fixed",
          densityClasses[density],
        )}
      >
        {children}
      </table>
    </div>
  );
}

export function THead(inputProps: THeadProps) {
  const { children, className: consumerClassName, rowClassName, style: consumerStyle, ...props } = inputProps as THeadProps & RuntimeStyleOverrides;
  void consumerClassName;
  void consumerStyle;
  void rowClassName;

  return (
    <thead {...props} data-slot="table-header" className="bg-app-surface sticky top-0 z-10">
      <tr className="text-app-label uppercase tracking-wider text-app-text-muted border-b border-app-border">{children}</tr>
    </thead>
  );
}

export function TBody(inputProps: TBodyProps) {
  const { children, className: consumerClassName, style: consumerStyle, ...props } = inputProps as TBodyProps & RuntimeStyleOverrides;
  void consumerClassName;
  void consumerStyle;

  return (
    <tbody {...props} data-slot="table-body" className="divide-y divide-app-border/40">
      {children}
    </tbody>
  );
}

export function TRow(inputProps: TRowProps) {
  const { children, className: consumerClassName, selected = false, style: consumerStyle, tooltip, variant = "default", ...props } = inputProps as TRowProps & RuntimeStyleOverrides;
  void consumerClassName;
  void consumerStyle;

  return (
    <tr
      {...props}
      data-selected={selected || undefined}
      data-slot="table-row"
      className={cn(
        "group/row relative transition-colors",
        variant === "default" && "hover:bg-app-surface-hover/50",
        variant === "separator" && "text-app-label text-app-text-dim",
        selected && "bg-app-accent/10",
        props.onClick && "cursor-pointer",
      )}
    >
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

export function TH(inputProps: THProps) {
  const {
    align = "start",
    children,
    className: consumerClassName,
    nowrap = false,
    showFrom,
    sticky,
    style: consumerStyle,
    visuallyHidden = false,
    ...props
  } = inputProps as THProps & RuntimeStyleOverrides;
  void consumerClassName;
  void consumerStyle;

  return (
    <th
      {...props}
      data-slot="table-head"
      className={cn(
        "px-3 py-2",
        alignClasses[align],
        showFrom === "sm" && "hidden sm:table-cell",
        nowrap && "whitespace-nowrap",
        visuallyHidden && "sr-only",
        sticky === "start" && "sticky left-0 z-20 bg-app-surface",
        props.onClick && "cursor-pointer select-none hover:text-app-text",
      )}
    >
      {children}
    </th>
  );
}

export function SortableTH({ children, direction, onSort, ...props }: SortableTHProps) {
  return (
    <TH
      {...props}
      aria-sort={direction}
      onClick={onSort}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSort();
      }}
      tabIndex={0}
    >
      <span className={cn("inline-flex items-center gap-1 transition-colors", direction && "text-app-accent")}>
        {children}
        {direction && <span aria-hidden="true">{direction === "ascending" ? "↑" : "↓"}</span>}
      </span>
    </TH>
  );
}

export function TD(inputProps: TDProps) {
  const {
    align = "start",
    children,
    className: consumerClassName,
    emphasis = false,
    numeric = false,
    nowrap = false,
    sticky,
    showFrom,
    style: consumerStyle,
    tone = "default",
    truncate,
    ...props
  } = inputProps as TDProps & RuntimeStyleOverrides;
  void consumerClassName;
  void consumerStyle;

  return (
    <td
      {...props}
      data-slot="table-cell"
      className={cn(
        "px-3 py-2",
        alignClasses[align],
        toneClasses[tone],
        emphasis && "font-semibold",
        showFrom === "sm" && "hidden sm:table-cell",
        numeric && "font-mono tabular-nums",
        nowrap && "whitespace-nowrap",
        sticky === "start" && "sticky left-0 z-10 bg-inherit",
        truncate === "narrow" && "max-w-[140px] truncate",
        truncate === "wide" && "max-w-[200px] truncate",
      )}
    >
      {children}
    </td>
  );
}

export const TableHeader = THead;
export const TableBody = TBody;
export const TableRow = TRow;
export const TableHead = TH;
export const TableCell = TD;
