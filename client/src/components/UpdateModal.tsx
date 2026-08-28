import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { ReleaseNotes } from "@/components/ReleaseNotes";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { telemetryStore, useTelemetryStore } from "@/stores/telemetry";

const STEPS = ["downloading", "installing", "reconnecting", "complete"] as const;

function StepIndicator({ step, current }: { step: (typeof STEPS)[number]; current: (typeof STEPS)[number] | null }) {
  const stepIdx = current ? STEPS.indexOf(current) : -1;
  const thisIdx = STEPS.indexOf(step);
  const isActive = step === current;
  const isDone = stepIdx > thisIdx;

  const labels: Record<string, string> = {
    downloading: m.label_download(),
    installing: m.update_step_install(),
    reconnecting: m.update_step_restart(),
    complete: m.update_step_done(),
  };

  return (
    <div className="flex items-center gap-2">
      <div
        className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
          isDone ? "bg-status-success text-app-on-filled" : isActive ? "bg-app-accent text-app-on-filled" : "bg-app-surface-alt text-app-text-muted"
        }`}
      >
        {isDone ? "✓" : thisIdx + 1}
      </div>
      <span className={`text-xs font-medium ${isActive ? "text-app-text" : isDone ? "text-status-success" : "text-app-text-muted"}`}>{labels[step]}</span>
    </div>
  );
}

export function UpdateModal({ version, currentVersion, newReleases, fullReleaseNotes, currentReleaseNotes, currentReleaseDate, onClose }: { version: string; currentVersion: string; newReleases: { version: string; notes: string; date: string }[]; fullReleaseNotes: string | null; currentReleaseNotes: string | null; currentReleaseDate: string | null; onClose: () => void }) {
  const updateProgress = useTelemetryStore((s) => s.updateProgress);
  const [error, setError] = useState<string | null>(null);
  const [showAllReleases, setShowAllReleases] = useState(false);

  const stage = updateProgress?.stage ?? null;
  const releasesToDisplay = currentReleaseNotes ? [...newReleases, { version: currentVersion, notes: currentReleaseNotes, date: currentReleaseDate ?? "" }] : newReleases;
  const percent = updateProgress?.percent ?? 0;

  const handleInstall = async () => {
    setError(null);
    telemetryStore.actions.setUpdateProgress({ stage: "downloading", percent: 0 });
    try {
      const res = await client.api.update.apply.$post();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${m.update_failed_status()} (${res.status})`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : m.update_failed());
      telemetryStore.actions.setUpdateProgress(null);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg/60 p-4">
      {!isUpdating && <button type="button" aria-label={m.common_close()} className="absolute inset-0 cursor-default" onClick={onClose} />}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg border border-app-border bg-app-bg shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <h2 id="update-modal-title" className="text-sm font-semibold text-app-text">
            {stage === "complete" ? m.update_title_complete() : stage ? m.update_title_updating() : m.update_title_available()}
          </h2>
          {!isUpdating && (
            <Button variant="close-action" size="icon-sm" onClick={onClose} aria-label={m.common_close()}>
              <X className="size-4" />
            </Button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-5">
          {/* Pre-install state */}
          {!stage && !error && (
            <>
              <p className="text-sm text-app-text-secondary">
                RaceIQ <span className="font-mono text-app-accent">v{version}</span> {m.update_ready_suffix()}
              </p>
              {fullReleaseNotes ? (
                <div className="max-h-52 overflow-y-auto">
                  <ReleaseNotes notes={fullReleaseNotes} />
                </div>
              ) : (
                releasesToDisplay.length > 0 &&
                (() => {
                  const [latest, ...older] = releasesToDisplay;
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
                        <Button variant="app-ghost" size="app-sm" onClick={() => setShowAllReleases(true)}>
                          {m.update_show_earlier_prefix()} {older.length} {m.update_show_earlier_suffix()}
                        </Button>
                      )}
                      {showAllReleases &&
                        older.map((r) => (
                          <div key={r.version}>
                            <div className="flex items-baseline justify-between mb-1">
                              <span className="text-xs font-medium text-app-text">v{r.version}</span>
                              {r.date && <span className="text-xs text-app-text-muted">{new Date(r.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>}
                            </div>
                            <ReleaseNotes notes={r.notes} />
                          </div>
                        ))}
                    </div>
                  );
                })()
              )}
              <div className="flex justify-end gap-3">
                <Button variant="app-primary" size="app-md" onClick={handleInstall}>
                  {m.label_install_update()}
                </Button>
                <Button variant="app-outline" size="app-md" onClick={onClose}>
                  {m.update_later()}
                </Button>
              </div>
            </>
          )}

          {/* Error state */}
          {error && (
            <>
              <p className="text-sm text-status-danger">{error}</p>
              <div className="flex justify-end gap-3">
                <Button variant="app-primary" size="app-md" onClick={handleInstall}>
                  {m.label_retry()}
                </Button>
                <Button variant="app-outline" size="app-md" onClick={onClose}>
                  {m.common_close()}
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
                    {i < STEPS.length - 1 && <div className={`w-8 h-px mx-2 ${STEPS.indexOf(stage) > i ? "bg-status-success" : "bg-app-border"}`} />}
                  </div>
                ))}
              </div>

              {/* Download progress bar */}
              {stage === "downloading" && (
                <div className="space-y-2">
                  <div className="h-2 rounded-full bg-app-progress-track overflow-hidden">
                    <div className="h-full rounded-full bg-app-accent transition-all duration-300" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="text-xs text-app-text-muted text-center">
                    {m.update_downloading()} {percent}%
                  </p>
                </div>
              )}

              {/* Installing */}
              {stage === "installing" && <p className="text-xs text-app-text-muted text-center animate-pulse">{m.label_running_installer()}</p>}

              {/* Reconnecting */}
              {stage === "reconnecting" && <p className="text-xs text-app-text-muted text-center animate-pulse">{m.updates_reconnecting()}</p>}

              {/* Complete */}
              {stage === "complete" && (
                <div className="text-center space-y-2">
                  <p className="text-sm text-status-success font-medium">{m.updates_complete()}</p>
                  <p className="text-xs text-app-text-muted">
                    {m.update_refreshing()} {countdown ?? 0}s...
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
