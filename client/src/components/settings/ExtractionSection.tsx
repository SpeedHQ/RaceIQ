import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";

export function ExtractionSection() {
  const [status, setStatus] = useState<{
    status: string;
    installed: boolean;
    extracted: number;
    failed: number;
    total: number;
    current: string;
    error: string;
  } | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await client.api.extraction.status.$get();
      setStatus(await res.json());
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // Poll while running
  useEffect(() => {
    if (status?.status !== "running") return;
    const interval = setInterval(fetchStatus, 500);
    return () => clearInterval(interval);
  }, [status?.status]);

  const handleExtract = async () => {
    await client.api.extraction.run.$post();
    fetchStatus();
  };

  const isRunning = status?.status === "running";
  const isDone = status?.status === "done";
  const progress = status && status.total > 0 ? Math.round(((status.extracted + status.failed) / status.total) * 100) : 0;

  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-4">{m.extraction_fm_title()}</h2>

      {!status?.installed && (
        <div className="rounded-md bg-status-warning/10 border border-status-warning/30 p-3 mb-4">
          <p className="text-sm text-status-warning">{m.extraction_fm_not_detected()}</p>
        </div>
      )}

      {isDone && status.extracted > 0 && (
        <div className="rounded-md bg-status-success/10 border border-status-success/30 p-3 mb-4">
          <p className="text-sm text-status-success">
            {status.extracted} {m.extraction_track_outlines_extracted()}
            {status.failed > 0 && <span className="text-app-text-muted"> ({status.failed} {m.extraction_skipped()})</span>}
          </p>
        </div>
      )}

      {status?.status === "error" && (
        <div className="rounded-md bg-status-danger/10 border border-status-danger/30 p-3 mb-4">
          <p className="text-sm text-status-danger">{status.error}</p>
        </div>
      )}

      {isRunning && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-2 flex-1 rounded-full bg-app-surface-alt overflow-hidden">
              <div className="h-full bg-app-accent transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs text-app-text-muted w-10 text-right">{progress}%</span>
          </div>
          <p className="text-xs text-app-text-muted">
            {m.extraction_extracting_label()} {status.current}... ({status.extracted} {m.extraction_done_label()})
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={handleExtract} disabled={isRunning || !status?.installed} variant={isDone ? "outline" : "default"}>
          {isRunning ? m.extraction_extracting() : isDone ? m.extraction_reextract() : m.extraction_extract_track_data()}
        </Button>
        {isDone && status.extracted > 0 && (
          <Button
            variant="outline"
            className="text-status-danger border-status-danger/30 hover:bg-status-danger/10"
            onClick={async () => {
              await client.api.extraction.data.$delete();
              fetchStatus();
            }}
          >
            {m.extraction_delete_data()}
          </Button>
        )}
      </div>
    </section>
  );
}
