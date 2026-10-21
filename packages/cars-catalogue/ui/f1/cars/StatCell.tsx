import { useCarsCatalogueHost } from "../../host";
import { getRatingColor } from "./utils";

export function StatCell({ value, bold }: { value: number; bold?: boolean }) {
  const { TableCell } = useCarsCatalogueHost();
  return (
    <TableCell className="text-right">
      <span className={`font-mono text-xs ${getRatingColor(value)} ${bold ? "font-bold" : ""}`}>{value}</span>
    </TableCell>
  );
}
