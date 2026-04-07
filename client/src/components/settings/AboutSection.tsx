import { useEffect, useState } from "react";
import { client } from "@/lib/rpc";

export function AboutSection() {
  const [versionInfo, setVersionInfo] = useState<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    checked: boolean;
  } | null>(null);

  useEffect(() => {
    client.api.version.$get()
      .then((r) => r.json())
      .then(setVersionInfo)
      .catch(() => {});
  }, []);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-app-text mb-4">About</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between py-2 border-b border-app-border">
            <span className="text-sm text-app-text-secondary">Version</span>
            <span className="text-sm text-app-text font-mono">
              {versionInfo ? `v${versionInfo.current}` : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-app-border">
            <span className="text-sm text-app-text-secondary">Latest release</span>
            <span className="text-sm text-app-text font-mono">
              {!versionInfo?.checked
                ? "Checking..."
                : versionInfo.latest
                  ? `v${versionInfo.latest}`
                  : "Unknown"}
            </span>
          </div>
          {versionInfo?.updateAvailable && (
            <div className="flex items-center justify-between py-3 px-4 rounded-lg bg-yellow-400/10 border border-yellow-400/30">
              <span className="text-sm text-yellow-400">Update available</span>
              <a
                href="https://github.com/SpeedHQ/RaceIQ/releases/latest"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-yellow-400 underline underline-offset-2"
              >
                Download v{versionInfo.latest}
              </a>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
