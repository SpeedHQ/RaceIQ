import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ReleaseNotes } from "@/components/ReleaseNotes";
import { useTelemetryStore } from "@/stores/telemetry";
import { client } from "@/lib/rpc";

export function UpdatesSection() {
  const updateAvailable = useTelemetryStore((s) => s.updateAvailable);
  const updateProgress = useTelemetryStore((s) => s.updateProgress);
  const versionInfo = useTelemetryStore((s) => s.versionInfo);
  const [checking, setChecking] = useState(false);

  const handleCheck = async () => {
    setChecking(true);
    try {
      await client.api.update.check.$post();
      // Refetch version info into Zustand
      const res = await client.api.version.$get();
      const data = await res.json();
      useTelemetryStore.getState().setVersionInfo(data as unknown as import("@/stores/telemetry").VersionInfo);
    } catch {} finally {
      setChecking(false);
    }
  };

  const handleInstall = async () => {
    useTelemetryStore.getState().setUpdateProgress({ stage: "downloading", percent: 0 });
    try {
      await client.api.update.apply.$post();
    } catch {
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
        <h2 className="text-lg font-semibold text-app-text">Updates</h2>
        {!stage && (
          <Button onClick={handleCheck} disabled={checking} variant="outline" size="sm">
            {checking ? "Checking..." : "Check for Updates"}
          </Button>
        )}
      </div>
      <div className="text-sm text-app-text-muted mb-4 space-y-0.5">
        {currentVersion && (
          <p>Current version: <span className="text-app-text font-mono">{currentVersion}</span></p>
        )}
        {versionInfo?.lastChecked && (
          <p>Last checked: {new Date(versionInfo.lastChecked).toLocaleString()}</p>
        )}
      </div>

      {/* Update progress */}
      {stage && (
        <div className="rounded-lg border border-app-accent/30 bg-app-accent/5 p-4 space-y-3 mb-4">
          {stage === "downloading" && (
            <>
              <p className="text-sm font-medium text-app-accent">Downloading installer... {percent}%</p>
              <div className="h-2 rounded-full bg-app-surface-2 overflow-hidden">
                <div className="h-full rounded-full bg-app-accent transition-all duration-300" style={{ width: `${percent}%` }} />
              </div>
            </>
          )}
          {stage === "installing" && (
            <p className="text-sm font-medium text-app-accent animate-pulse">Running installer...</p>
          )}
          {stage === "reconnecting" && (
            <p className="text-sm font-medium text-app-accent animate-pulse">Waiting for RaceIQ to restart...</p>
          )}
          {stage === "complete" && (
            <p className="text-sm font-medium text-green-400">Update installed successfully!</p>
          )}
        </div>
      )}

      {/* Update available (not currently updating) */}
      {!stage && showUpdate && latestVersion && (
        <div className="rounded-lg border border-app-accent/30 bg-app-accent/5 p-4 space-y-3 mb-4">
          <p className="text-sm font-medium text-app-accent">
            Update available: v{latestVersion}
          </p>
          <Button onClick={handleInstall} className="bg-app-accent text-black hover:bg-app-accent/90">
            Install Update
          </Button>
        </div>
      )}

      {/* Up to date */}
      {!stage && versionInfo?.checked && !showUpdate && (
        <p className="text-sm text-app-text-muted mb-4">
          You&apos;re on the latest version.
        </p>
      )}

      {/* Release notes for versions between current and latest */}
      {!stage && versionInfo?.newReleases && versionInfo.newReleases.length > 0 && (
        <div className="mb-4 space-y-3">
          {versionInfo.newReleases.map((r) => (
            <div key={r.version}>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-sm font-medium text-app-text">v{r.version}</h3>
                {r.date && (
                  <span className="text-xs text-app-text-muted">Released {new Date(r.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
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
            <h3 className="text-sm font-medium text-app-text">Current Release (v{versionInfo.current})</h3>
            {versionInfo.currentReleaseDate && (
              <span className="text-xs text-app-text-muted">Released {new Date(versionInfo.currentReleaseDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
            )}
          </div>
          <ReleaseNotes notes={versionInfo.currentReleaseNotes} />
        </div>
      )}

    </section>
  );
}
