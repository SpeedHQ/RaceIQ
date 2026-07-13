import { useState } from "react";
import { client } from "@/lib/rpc";
import { detectBrowser } from "@/lib/browser-detect";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export function DiagnosticsSection() {
  const [status, setStatus] = useState<"idle" | "downloading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleDownload() {
    setStatus("downloading");
    setErrorMsg("");
    try {
      const browser = detectBrowser();
      const query: Record<string, string> = {
        browserName: browser.name,
        browserVersion: browser.version,
        browserEngine: browser.engine,
        browserUA: browser.userAgent,
      };

      // Get browser memory usage if available (Chrome/Edge)
      const perf = performance as unknown as {
        memory?: { usedJSHeapSize: number };
      };
      if (typeof perf.memory === "object" && perf.memory?.usedJSHeapSize) {
        const memMB = Math.round(perf.memory.usedJSHeapSize / 1024 / 1024);
        query.browserMemory = memMB.toString();
      }

      const res = await client.api.diagnostics.$get({ query });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `raceiq-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : m.diag_download_failed());
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-app-text mb-1">{m.diag_title()}</h2>
        <p className="text-xs text-app-text-muted mb-4">
          {m.diag_desc()}
        </p>
      </div>

      <div className="space-y-3">
        <div className="rounded-lg border border-app-border bg-app-surface-alt/50 p-4 space-y-2 text-xs text-app-text-secondary">
          <p>{m.diag_zip_contains()}</p>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li>
              <span className="font-mono">diagnostics.json</span> {m.diag_json_desc()}
            </li>
            <li>
              <span className="font-mono">logs.txt</span> {m.diag_logs_desc()}
            </li>
          </ul>
        </div>

        <Button onClick={handleDownload} disabled={status === "downloading"} className="w-full">
          {status === "downloading" ? m.diag_collecting() : m.diag_download_button()}
        </Button>

        {status === "error" && <p className="text-xs text-red-400">{errorMsg}</p>}
      </div>
    </section>
  );
}
