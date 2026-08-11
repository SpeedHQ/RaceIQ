import { useState } from "react";
import { ReleaseNotes } from "@/components/ReleaseNotes";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import type { VersionInfo } from "@/stores/telemetry";
import { useTelemetryStore } from "@/stores/telemetry";
import { ProcessingMaintenance } from "../ProcessingMaintenance";
export function UpdatesSection() {
  const updateAvailable = useTelemetryStore((s) => s.updateAvailable);
  const updateProgress = useTelemetryStore((s) => s.updateProgress);
  const versionInfo = useTelemetryStore((s) => s.versionInfo);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);

  const handleCheck = async () => {
    setChecking(true);
    setError(false);
    try {
      const checkResponse = await client.api.update.check.$post();
      if (!checkResponse.ok) throw new Error(`update check failed: ${checkResponse.status}`);
      // Refetch version info into Zustand
      const res = await client.api.version.$get();
      if (!res.ok) throw new Error(`version request failed: ${res.status}`);
      const data = await res.json();
      useTelemetryStore.getState().setVersionInfo(data as VersionInfo);
    } catch {
      setError(true);
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = async () => {
    setError(false);
    useTelemetryStore.getState().setUpdateProgress({ stage: "downloading", percent: 0 });
    try {
      const response = await client.api.update.apply.$post();
      if (!response.ok) throw new Error(`update apply failed: ${response.status}`);
    } catch {
      setError(true);
      useTelemetryStore.getState().setUpdateProgress(null);
    }
  };

  const showUpdate = versionInfo?.updateAvailable || !!updateAvailable;
  const latestVersion = versionInfo?.latest ?? updateAvailable;
  const currentVersion = versionInfo?.current;
  const stage = updateProgress?.stage ?? null;
  const percent = updateProgress?.percent ?? 0;

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold text-app-text">{m.label_updates()}</h2>
        {!stage && (
          <Button onClick={handleCheck} disabled={checking} variant="outline" size="sm">
            {checking ? m.label_checking() : m.updates_check_button()}
          </Button>
        )}
        {error && (
          <p className="text-sm text-status-danger mb-4" role="alert">
            {m.update_failed()}
          </p>
        )}
      </div>
      <div className="text-sm text-app-text-muted mb-4 space-y-0.5">
        {currentVersion && (
          <p>
            {m.updates_current_version()} <span className="text-app-text font-mono">{currentVersion}</span>
          </p>
        )}
        {versionInfo?.lastChecked && (
          <p>
            {m.updates_last_checked()} {new Date(versionInfo.lastChecked).toLocaleString()}
          </p>
        )}
      </div>

      {/* Update progress */}
      {stage && (
        <div className="rounded-lg border border-app-accent/30 bg-app-accent/5 p-4 space-y-3 mb-4">
          {stage === "downloading" && (
            <>
              <p className="text-sm font-medium text-app-accent">
                {m.updates_downloading()} {percent}%
              </p>
              <div className="h-2 rounded-full bg-app-progress-track overflow-hidden">
                <div className="h-full rounded-full bg-app-accent transition-all duration-300" style={{ width: `${percent}%` }} />
              </div>
            </>
          )}
          {stage === "installing" && <p className="text-sm font-medium text-app-accent animate-pulse">{m.label_running_installer()}</p>}
          {stage === "reconnecting" && <p className="text-sm font-medium text-app-accent animate-pulse">{m.updates_reconnecting()}</p>}
          {stage === "complete" && <p className="text-sm font-medium text-status-success">{m.updates_complete()}</p>}
        </div>
      )}

      {/* Update available (not currently updating) */}
      {!stage && showUpdate && latestVersion && (
        <div className="rounded-lg border border-app-accent/30 bg-app-accent/5 p-4 space-y-3 mb-4">
          <p className="text-sm font-medium text-app-accent">
            {m.updates_available()} v{latestVersion}
          </p>
          <Button onClick={handleInstall} variant="app-primary">
            {m.label_install_update()}
          </Button>
        </div>
      )}

      {/* Up to date */}
      {!stage && versionInfo?.checked && !showUpdate && <p className="text-sm text-app-text-muted mb-4">{m.updates_up_to_date()}</p>}

      {/* Release notes for versions between current and latest */}
      {!stage && versionInfo?.newReleases && versionInfo.newReleases.length > 0 && (
        <div className="mb-4 space-y-3">
          {versionInfo.newReleases.map((r) => (
            <div key={r.version}>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-sm font-medium text-app-text">v{r.version}</h3>
                {r.date && (
                  <span className="text-xs text-app-text-muted">
                    {m.updates_released()} {new Date(r.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                  </span>
                )}
              </div>
              <ReleaseNotes notes={r.notes} />
            </div>
          ))}
        </div>
      )}

      {/* Release notes for current version */}
      {!stage && versionInfo?.currentReleaseNotes && (
        <div className="mb-4">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-sm font-medium text-app-text">
              {m.updates_current_release()} (v{versionInfo.current})
            </h3>
            {versionInfo.currentReleaseDate && (
              <span className="text-xs text-app-text-muted">
                {m.updates_released()} {new Date(versionInfo.currentReleaseDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
              </span>
            )}
          </div>
          <ReleaseNotes notes={versionInfo.currentReleaseNotes} />
        </div>
      )}

      <ProcessingMaintenance />
    </section>
  );
}
