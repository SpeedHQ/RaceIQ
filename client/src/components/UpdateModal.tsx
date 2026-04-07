import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ReleaseNotes } from "@/components/ReleaseNotes";
import { useTelemetryStore } from "@/stores/telemetry";
import { client } from "@/lib/rpc";

const STEPS = ["downloading", "installing", "reconnecting", "complete"] as const;

function StepIndicator({ step, current }: { step: typeof STEPS[number]; current: typeof STEPS[number] | null }) {
  const stepIdx = current ? STEPS.indexOf(current) : -1;
  const thisIdx = STEPS.indexOf(step);
  const isActive = step === current;
  const isDone = stepIdx > thisIdx;

  const labels: Record<string, string> = {
    downloading: "Download",
    installing: "Install",
    reconnecting: "Restart",
    complete: "Done",
  };

  return (
    <div className="flex items-center gap-2">
      <div
        className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
          isDone
            ? "bg-green-500 text-black"
            : isActive
              ? "bg-app-accent text-black"
              : "bg-app-surface-2 text-app-text-muted"
        }`}
      >
        {isDone ? "✓" : thisIdx + 1}
      </div>
      <span className={`text-xs font-medium ${isActive ? "text-app-text" : isDone ? "text-green-400" : "text-app-text-muted"}`}>
        {labels[step]}
      </span>
    </div>
  );
}

export function UpdateModal({ version, newReleases, onClose }: { version: string; newReleases: { version: string; notes: string; date: string }[]; onClose: () => void }) {
  const updateProgress = useTelemetryStore((s) => s.updateProgress);
  const [error, setError] = useState<string | null>(null);
  const [showAllReleases, setShowAllReleases] = useState(false);

  const stage = updateProgress?.stage ?? null;
  const percent = updateProgress?.percent ?? 0;

  const handleInstall = async () => {
    setError(null);
    useTelemetryStore.getState().setUpdateProgress({ stage: "downloading", percent: 0 });
    try {
      const res = await client.api.update.apply.$post();
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed (${res.status})`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Update failed");
      useTelemetryStore.getState().setUpdateProgress(null);
    }
  };

  // Auto-refresh after complete
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (stage === "complete") {
      setCountdown(5);
      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(interval);
            window.location.reload();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [stage]);

  const isUpdating = stage !== null && stage !== "complete";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={isUpdating ? undefined : onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-app-border bg-app-bg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <h2 className="text-sm font-semibold text-app-text">
            {stage === "complete" ? "Update Complete" : stage ? "Updating RaceIQ" : "Update Available"}
          </h2>
          {!isUpdating && (
            <button onClick={onClose} className="text-app-text-muted hover:text-app-text text-lg leading-none">&times;</button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-5">
          {/* Pre-install state */}
          {!stage && !error && (
            <>
              <p className="text-sm text-app-text-secondary">
                RaceIQ <span className="font-mono text-app-accent">v{version}</span> is ready to install.
              </p>
              {newReleases.length > 0 && (() => {
                const [latest, ...older] = newReleases;
                return (
                  <div className="max-h-52 overflow-y-auto space-y-3">
                    <div>
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-xs font-medium text-app-text">v{latest.version}</span>
                        {latest.date && (
                          <span className="text-xs text-app-text-muted">{new Date(latest.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
                        )}
                      </div>
                      <ReleaseNotes notes={latest.notes} />
                    </div>
                    {older.length > 0 && !showAllReleases && (
                      <button
                        onClick={() => setShowAllReleases(true)}
                        className="text-xs text-app-accent hover:underline"
                      >
                        Show {older.length} earlier release{older.length > 1 ? "s" : ""}
                      </button>
                    )}
                    {showAllReleases && older.map((r) => (
                      <div key={r.version}>
                        <div className="flex items-baseline justify-between mb-1">
                          <span className="text-xs font-medium text-app-text">v{r.version}</span>
                          {r.date && (
                            <span className="text-xs text-app-text-muted">{new Date(r.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
                          )}
                        </div>
                        <ReleaseNotes notes={r.notes} />
                      </div>
                    ))}
                  </div>
                );
              })()}
              <div className="flex justify-end gap-3">
                <Button onClick={handleInstall} className="bg-app-accent text-black hover:bg-app-accent/90">
                  Install Update
                </Button>
                <Button variant="outline" onClick={onClose}>
                  Later
                </Button>
              </div>
            </>
          )}

          {/* Error state */}
          {error && (
            <>
              <p className="text-sm text-red-400">{error}</p>
              <div className="flex justify-end gap-3">
                <Button onClick={handleInstall} className="bg-app-accent text-black hover:bg-app-accent/90">
                  Retry
                </Button>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          )}

          {/* Progress state */}
          {stage && (
            <>
              {/* Step indicators */}
              <div className="flex items-center justify-between">
                {STEPS.map((s, i) => (
                  <div key={s} className="flex items-center">
                    <StepIndicator step={s} current={stage} />
                    {i < STEPS.length - 1 && (
                      <div className={`w-8 h-px mx-2 ${STEPS.indexOf(stage) > i ? "bg-green-500" : "bg-app-border"}`} />
                    )}
                  </div>
                ))}
              </div>

              {/* Download progress bar */}
              {stage === "downloading" && (
                <div className="space-y-2">
                  <div className="h-2 rounded-full bg-app-surface-2 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-app-accent transition-all duration-300"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <p className="text-xs text-app-text-muted text-center">
                    Downloading installer... {percent}%
                  </p>
                </div>
              )}

              {/* Installing */}
              {stage === "installing" && (
                <p className="text-xs text-app-text-muted text-center animate-pulse">
                  Running installer...
                </p>
              )}

              {/* Reconnecting */}
              {stage === "reconnecting" && (
                <p className="text-xs text-app-text-muted text-center animate-pulse">
                  Waiting for RaceIQ to restart...
                </p>
              )}

              {/* Complete */}
              {stage === "complete" && (
                <div className="text-center space-y-2">
                  <p className="text-sm text-green-400 font-medium">Update installed successfully!</p>
                  <p className="text-xs text-app-text-muted">Refreshing in {countdown ?? 0}s...</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
