import type { ChangelogEntry } from "@shared/changelog";
import { useEffect, useState } from "react";
import { ReleaseNotes } from "@/components/ReleaseNotes";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useTelemetryStore } from "@/stores/telemetry";

export function UpdatesSection() {
  const updateAvailable = useTelemetryStore((s) => s.updateAvailable);
  const updateProgress = useTelemetryStore((s) => s.updateProgress);
  const versionInfo = useTelemetryStore((s) => s.versionInfo);
  const [checking, setChecking] = useState(false);
  const [history, setHistory] = useState<ChangelogEntry[]>([]);

  useEffect(() => {
    let active = true;
    void client.api.changelog
      .$get()
      .then(async (res) => {
        if (res.ok && active) setHistory(await res.json());
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    try {
      await client.api.update.check.$post();
      // Refetch version info into Zustand
      const res = await client.api.version.$get();
      const data = await res.json();
      useTelemetryStore.getState().setVersionInfo(data as unknown as import("@/stores/telemetry").VersionInfo);
    } catch {
    } finally {
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
        <h2 className="text-lg font-semibold text-app-text">{m.label_updates()}</h2>
        {!stage && (
          <Button onClick={handleCheck} disabled={checking} variant="outline" size="sm">
            {checking ? m.label_checking() : m.updates_check_button()}
          </Button>
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
              <div className="h-2 rounded-full bg-app-surface-2 overflow-hidden">
                <div className="h-full rounded-full bg-app-accent transition-all duration-300" style={{ width: `${percent}%` }} />
              </div>
            </>
          )}
          {stage === "installing" && <p className="text-sm font-medium text-app-accent animate-pulse">{m.label_running_installer()}</p>}
          {stage === "reconnecting" && <p className="text-sm font-medium text-app-accent animate-pulse">{m.updates_reconnecting()}</p>}
          {stage === "complete" && <p className="text-sm font-medium text-green-400">{m.updates_complete()}</p>}
        </div>
      )}

      {/* Update available (not currently updating) */}
      {!stage && showUpdate && latestVersion && (
        <div className="rounded-lg border border-app-accent/30 bg-app-accent/5 p-4 space-y-3 mb-4">
          <p className="text-sm font-medium text-app-accent">
            {m.updates_available()} v{latestVersion}
          </p>
          <Button onClick={handleInstall} className="bg-app-accent text-black hover:bg-app-accent/90">
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
      {!stage && history.length > 0 && (
        <div className="border-t border-app-border pt-4 mt-4">
          <h3 className="text-sm font-semibold text-app-text mb-3">Version history</h3>
          <div className="space-y-4">
            {history.map((release) => (
              <div key={release.version}>
                <div className="flex items-baseline justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium text-app-text">v{release.version}</h4>
                    {release.breaking && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Breaking</span>}
                  </div>
                  {release.date && (
                    <span className="text-xs text-app-text-muted">
                      {m.updates_released()} {new Date(release.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                    </span>
                  )}
                </div>
                <ReleaseNotes notes={release.notes} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
