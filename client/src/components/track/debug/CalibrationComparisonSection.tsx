import type { CalibrationComparison, CalibrationTransform } from "./calibration-comparison";

function TransformValues({ transform }: { transform: CalibrationTransform }) {
  return (
    <span className="font-mono tabular-nums text-app-text">
      {transform.scale.toFixed(3)}× · {(transform.rotation * 180 / Math.PI).toFixed(1)}° · ({transform.tx.toFixed(1)}, {transform.tz.toFixed(1)})
    </span>
  );
}

export function CalibrationComparisonSection({
  comparison,
  showHistory,
  onShowHistoryChange,
}: {
  comparison: CalibrationComparison | null;
  showHistory: boolean;
  onShowHistoryChange: (show: boolean) => void;
}) {
  const historyCount = comparison?.history.length ?? 0;

  return (
    <section className="rounded-lg border border-app-border bg-app-surface/50 p-3" aria-labelledby="calibration-comparison-title">
      <div id="calibration-comparison-title" className="mb-2 text-app-label uppercase tracking-wider text-app-text-muted">
        Calibration comparison
      </div>

      {!comparison ? (
        <p className="text-app-compact text-app-text-dim">Comparison data unavailable.</p>
      ) : (
        <>
          <div className="space-y-1.5 text-app-compact">
            <div className="flex items-start gap-2">
              <span className="mt-1.5 h-0.5 w-3 shrink-0 bg-app-accent" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-app-text-secondary">Current</div>
                {comparison.current ? <TransformValues transform={comparison.current} /> : <span className="text-app-text-dim">Not calibrated</span>}
              </div>
            </div>

            {comparison.history.map((entry) => (
              <div key={entry.sequence} className="flex items-start gap-2">
                <span className="mt-1.5 h-0.5 w-3 shrink-0 bg-status-warning/60" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-app-text-secondary">Fit #{entry.sequence} · Lap {entry.lapNumber}</div>
                  <div className="font-mono tabular-nums text-app-text-dim">
                    {entry.rmse == null ? "RMSE —" : `${entry.rmse.toFixed(2)} m RMSE`} · {entry.points} pts
                  </div>
                </div>
              </div>
            ))}
          </div>

          {historyCount === 0 && (
            <p id="calibration-history-status" className="mt-2 text-app-compact text-app-text-dim">
              No accepted calibration fits yet · {comparison.pointsCollected} points collected
            </p>
          )}

          <label className={`mt-3 flex items-center gap-2 text-app-compact ${historyCount > 0 ? "cursor-pointer text-app-text-secondary" : "cursor-not-allowed text-app-text-dim"}`}>
            <input
              type="checkbox"
              className="size-4 accent-app-accent"
              checked={showHistory}
              disabled={historyCount === 0}
              aria-describedby={historyCount === 0 ? "calibration-history-status" : undefined}
              onChange={(event) => onShowHistoryChange(event.target.checked)}
            />
            <span>Show historical fits</span>
          </label>
        </>
      )}
    </section>
  );
}
