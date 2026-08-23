import type { TrackImageryOutputBudget } from "../../../../../shared/racing/tracks/imagery";
import { cn } from "@/lib/utils";

function formatBudgetBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(bytes >= 10_000_000_000 ? 1 : 2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 100_000_000 ? 0 : 1)} MB`;
  return `${Math.ceil(bytes / 1_000).toLocaleString()} KB`;
}

export function ImageryImportEstimate({ budget }: { budget: TrackImageryOutputBudget }) {
  return (
    <div
      role="status"
      className={cn(
        "mb-2 rounded border p-2 text-xs",
        budget.safe ? "border-app-border bg-app-surface-alt text-app-text-muted" : "border-severity-critical text-severity-critical",
      )}
    >
      <div className="font-semibold text-app-text">
        Estimated output: {budget.totalTiles.toLocaleString()} tiles, approximately {formatBudgetBytes(budget.estimatedPackBytes.minimum)}–
        {formatBudgetBytes(budget.estimatedPackBytes.maximum)}
      </div>
      <div>
        {budget.width.toLocaleString()} × {budget.height.toLocaleString()} px · {budget.totalPixels.toLocaleString()} pixels · {budget.columns.toLocaleString()} × {budget.rows.toLocaleString()} tile grid
      </div>
      <div>
        Uncompressed work {formatBudgetBytes(budget.estimatedUncompressedBytes)} · disk available {budget.availableDiskBytes === null ? "unknown" : formatBudgetBytes(budget.availableDiskBytes)}
      </div>
      <div>
        Job limit {Math.round(budget.maximumJobDurationMs / 60_000)} min · {budget.maximumConcurrency} concurrent import
      </div>
      {budget.problems.length > 0 && <div className="mt-1">{budget.overrideActive ? `Development override active: ${budget.problems.join("; ")}` : budget.problems.join("; ")}</div>}
    </div>
  );
}
