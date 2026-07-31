import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
interface ImportedLap {
  lapId: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carOrdinal: number;
  trackOrdinal: number;
}

interface ImportResult {
  ok: boolean;
  filename: string;
  gameId: string;
  routePrefix: string;
  packetCount: number;
  carModel?: string | null;
  trackName?: string | null;
  elapsedMs: number;
  laps: ImportedLap[];
}

export function ImportDumpPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const openInAnalyse = (lap: ImportedLap) => {
    if (!result) return;
    // Route is /{routePrefix}/analyse with ?track&car&lap search params
    navigate({
      to: `/${result.routePrefix}/analyse`,
      search: {
        track: lap.trackOrdinal || undefined,
        car: lap.carOrdinal || undefined,
        lap: lap.lapId,
      },
    });
  };

  const handleSelect = (f: File | null) => {
    setFile(f);
    setResult(null);
    setError(null);
  };

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/dev/import-dump", {
        method: "POST",
        body: form,
      });
      const body = (await res.json()) as ImportResult | { error: string; details?: string };
      if (!res.ok || !("ok" in body)) {
        const err = "error" in body ? body.error : "Import failed";
        setError(err);
      } else {
        setResult(body);
        // Refresh lap/session lists so new data appears in the app
        qc.invalidateQueries({ queryKey: ["laps"] });
        qc.invalidateQueries({ queryKey: ["sessions"] });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">{m.dev_import_dump_title()}</h2>
      <p className="text-sm text-app-text-muted mb-4">
        Upload a recorded <code className="text-xs bg-app-surface-alt px-1 py-0.5 rounded">.bin</code> or <code className="text-xs bg-app-surface-alt px-1 py-0.5 rounded">.bin.gz</code> dump. It's fed
        through the full pipeline so detected laps are saved to the database just like a live session.
      </p>

      <label
        htmlFor="dump-file-input"
        className="border-2 border-dashed border-app-border rounded-lg p-8 flex flex-col items-center gap-3 cursor-pointer hover:border-app-accent transition-colors"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0] ?? null;
          if (f) handleSelect(f);
        }}
      >
        <input id="dump-file-input" ref={inputRef} type="file" accept=".bin,.bin.gz" className="hidden" onChange={(e) => handleSelect(e.target.files?.[0] ?? null)} />
        {file ? (
          <div className="text-center">
            <div className="text-sm font-medium">{file.name}</div>
            <div className="text-xs text-app-text-muted mt-1">{(file.size / 1024).toFixed(1)} KB</div>
          </div>
        ) : (
          <>
            <div className="text-sm">{m.dev_drop_bin_file()}</div>
            <div className="text-xs text-app-text-muted">
              Filename must start with <code className="bg-app-surface-alt px-1 rounded">acc-</code>, <code className="bg-app-surface-alt px-1 rounded">fm-2023-</code>, or{" "}
              <code className="bg-app-surface-alt px-1 rounded">f1-2025-</code>
            </div>
          </>
        )}
      </label>

      <div className="mt-4 flex gap-2">
        <Button type="button" variant="app-primary" size="app-lg" onClick={handleImport} disabled={!file || importing} className="flex-1">
          {importing ? m.label_importing() : m.dev_import_button()}
        </Button>
        {file && !importing && (
          <Button type="button" variant="app-ghost" size="app-lg" onClick={() => handleSelect(null)}>
            {m.common_clear()}
          </Button>
        )}
      </div>

      {error && (
        <div className="mt-4 p-3 rounded bg-status-danger/10 border border-status-danger/30 text-status-danger text-sm">
          <div className="font-medium">{m.dev_import_failed()}</div>
          <div className="mt-1 text-xs break-words">{error}</div>
        </div>
      )}

      {result && (
        <div className="mt-4 p-3 rounded bg-status-success/10 border border-status-success/30 text-status-success text-sm">
          <div className="font-medium">{m.dev_import_complete()}</div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs font-mono">
            <div className="text-app-text-muted">File</div>
            <div className="truncate">{result.filename}</div>
            <div className="text-app-text-muted">Game</div>
            <div>{result.gameId}</div>
            <div className="text-app-text-muted">Packets</div>
            <div>{result.packetCount.toLocaleString()}</div>
            {result.carModel && (
              <>
                <div className="text-app-text-muted">Car</div>
                <div>{result.carModel}</div>
              </>
            )}
            {result.trackName && (
              <>
                <div className="text-app-text-muted">Track</div>
                <div>{result.trackName}</div>
              </>
            )}
            <div className="text-app-text-muted">Duration</div>
            <div>{result.elapsedMs} ms</div>
            <div className="text-app-text-muted">Laps saved</div>
            <div>{result.laps.length}</div>
          </div>

          {result.laps.length > 0 && (
            <div className="mt-3 pt-3 border-t border-status-success/30">
              <div className="text-xs text-app-text-muted mb-2">{m.dev_imported_laps()}</div>
              <div className="space-y-1">
                {result.laps.map((lap) => (
                  <div key={lap.lapId} className="flex items-center gap-2 px-2 py-1.5 rounded bg-app-surface-alt text-app-text">
                    <div className="flex-1 min-w-0 text-xs font-mono">
                      <span className="text-app-text-muted">#{lap.lapNumber}</span> <span>{formatLapTime(lap.lapTime)}</span>
                      {!lap.isValid && <span className="ml-2 px-1.5 py-0.5 rounded bg-status-danger/15 text-status-danger text-app-caption">invalid</span>}
                    </div>
                    <Button type="button" variant="app-primary" size="app-sm" onClick={() => openInAnalyse(lap)}>
                      {m.dev_open_analyse()}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
