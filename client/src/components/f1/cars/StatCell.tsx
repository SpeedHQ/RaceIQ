import { TableCell } from "@/components/ui/table";
import { getRatingColor } from "./utils";

export function StatCell({ value, bold }: { value: number; bold?: boolean }) {
  return (
    <TableCell className="text-right">
      <span className={`font-mono text-xs ${getRatingColor(value)} ${bold ? "font-bold" : ""}`}>{value}</span>
    </TableCell>
  );
}
