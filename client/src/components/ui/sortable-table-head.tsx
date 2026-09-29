import type { ComponentProps } from "react";
import { TableHead } from "@/components/ui/table";

interface SortableTableHeadProps extends Omit<ComponentProps<typeof TableHead>, "onClick" | "aria-sort"> {
  direction?: "ascending" | "descending";
  onSort: () => void;
}

export function SortableTableHead({ children, direction, onSort, ...headProps }: SortableTableHeadProps) {
  return (
    <TableHead aria-sort={direction ?? "none"} {...headProps}>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-inherit focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={onSort}
      >
        {children}
        {direction && <span aria-hidden="true">{direction === "ascending" ? "↑" : "↓"}</span>}
      </button>
    </TableHead>
  );
}
