import type { ComponentProps } from "react";
import { cn } from "cn";
import { TableHead } from "@/components/ui/table";

interface SortableTableHeadProps extends Omit<ComponentProps<typeof TableHead>, "onClick" | "aria-sort"> {
  direction?: "ascending" | "descending";
  onSort: () => void;
}

export function SortableTableHead({ children, direction, onSort, className, ...headProps }: SortableTableHeadProps) {
  return (
    <TableHead aria-sort={direction ?? "none"} className={cn("relative", className)} {...headProps}>
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1 text-inherit after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={onSort}
      >
        {children}
        {direction && <span aria-hidden="true">{direction === "ascending" ? "↑" : "↓"}</span>}
      </button>
    </TableHead>
  );
}
