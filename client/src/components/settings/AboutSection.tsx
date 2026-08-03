import { useEffect, useState } from "react";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";

export function AboutSection() {
  const [versionInfo, setVersionInfo] = useState<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    checked: boolean;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    client.api.version
      .$get()
      .then(async (response) => {
        if (!response.ok) throw new Error(`version request failed: ${response.status}`);
        return response.json();
      })
      .then(setVersionInfo)
      .catch(() => setLoadError(true));
  }, []);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-app-text mb-4">{m.label_about()}</h2>
        {loadError && (
          <p className="text-sm text-status-danger" role="alert">
            {m.update_failed()}
          </p>
        )}
        <div className="space-y-3">
          <div className="flex items-center justify-between py-2 border-b border-app-border">
            <span className="text-sm text-app-text-secondary">{m.about_version()}</span>
            <span className="text-sm text-app-text font-mono">{versionInfo ? `v${versionInfo.current}` : "—"}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-app-border">
            <span className="text-sm text-app-text-secondary">{m.about_latest_release()}</span>
            <span className="text-sm text-app-text font-mono">{!versionInfo?.checked ? m.label_checking() : versionInfo.latest ? `v${versionInfo.latest}` : m.about_unknown()}</span>
          </div>
          {versionInfo?.updateAvailable && (
            <div className="flex items-center justify-between py-3 px-4 rounded-lg bg-status-warning/10 border border-status-warning/30">
              <span className="text-sm text-status-warning">{m.about_update_available()}</span>
              <a href="https://github.com/SpeedHQ/RaceIQ/releases/latest" target="_blank" rel="noreferrer" className="text-xs text-status-warning underline underline-offset-2">
                {m.label_download()} v{versionInfo.latest}
              </a>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
