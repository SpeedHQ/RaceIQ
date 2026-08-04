import { TD } from "@/components/ui/AppTable";
import { getRatingColor } from "./utils";

export function StatCell({ value, bold }: { value: number; bold?: boolean }) {
  return (
    <TD align="end">
      <span className={`font-mono text-xs ${getRatingColor(value)} ${bold ? "font-bold" : ""}`}>{value}</span>
    </TD>
  );
}
