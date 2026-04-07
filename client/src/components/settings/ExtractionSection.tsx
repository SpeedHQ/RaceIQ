import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";

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
  const progress = status && status.total > 0
    ? Math.round((status.extracted + status.failed) / status.total * 100)
    : 0;

  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-4">Forza Motorsport 2023 Extraction</h2>

      {!status?.installed && (
        <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 p-3 mb-4">
          <p className="text-sm text-yellow-300">
            Forza Motorsport 2023 not detected. Make sure it's installed via Steam.
          </p>
        </div>
      )}

      {isDone && status.extracted > 0 && (
        <div className="rounded-md bg-green-500/10 border border-green-500/30 p-3 mb-4">
          <p className="text-sm text-green-300">
            {status.extracted} track outlines extracted
            {status.failed > 0 && <span className="text-app-text-muted"> ({status.failed} skipped)</span>}
          </p>
        </div>
      )}

      {status?.status === "error" && (
        <div className="rounded-md bg-red-500/10 border border-red-500/30 p-3 mb-4">
          <p className="text-sm text-red-300">{status.error}</p>
        </div>
      )}

      {isRunning && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-2 flex-1 rounded-full bg-app-surface-alt overflow-hidden">
              <div
                className="h-full bg-app-accent transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-app-text-muted w-10 text-right">{progress}%</span>
          </div>
          <p className="text-xs text-app-text-muted">
            Extracting {status.current}... ({status.extracted} done)
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          onClick={handleExtract}
          disabled={isRunning || !status?.installed}
          variant={isDone ? "outline" : "default"}
        >
          {isRunning ? "Extracting..." : isDone ? "Re-extract" : "Extract Track Data"}
        </Button>
        {isDone && status.extracted > 0 && (
          <Button
            variant="outline"
            className="text-red-400 border-red-500/30 hover:bg-red-500/10"
            onClick={async () => {
              await client.api.extraction.data.$delete();
              fetchStatus();
            }}
          >
            Delete Extracted Data
          </Button>
        )}
      </div>
    </section>
  );
}
