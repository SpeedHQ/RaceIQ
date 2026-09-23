import type { SessionOwnership } from "@shared/racing/sessions/types";
import { useRef, useState } from "react";
import { OwnershipChoice } from "../import/OwnershipChoice";
import { importLapsZip } from "../../lib/lap-export";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { m } from "../../paraglide/messages";

type DetectedFormat = "zip" | "bin" | "duckdb" | "ibt" | "motec" | "unknown";
type DetectionResult = {
  format: DetectedFormat;
  supported: boolean;
  gameIds: string[];
  captureCount: number;
  message: string | null;
  preview?: {
    driverName: string;
    carName: string;
    trackName: string;
    completedLapCount: number;
  };
};

type ImportResult = {
  imported: number;
  skipped?: number;
  gameId?: string;
  packetCount?: number;
};

function formatLabel(format: DetectedFormat): string {
  switch (format) {
    case "zip": return m.session_format_zip();
    case "bin": return m.session_format_bin();
    case "duckdb": return "Le Mans Ultimate telemetry (.duckdb)";
    case "ibt": return m.session_format_ibt();
    case "motec": return m.session_format_motec();
    default: return m.session_format_unknown();
  }
}

export function SessionImportModal({ onClose, onImported }: { onClose: () => void; onImported?: (result: ImportResult) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [walFile, setWalFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<DetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [ownership, setOwnership] = useState<SessionOwnership>("mine");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function chooseFile(nextFile: File | null, nextWalFile: File | null) {
    setFile(nextFile);
    setWalFile(nextWalFile);
    setDetected(null);
    setError(null);
    setResult(null);
    if (!nextFile) return;
    setDetecting(true);
    try {
      const body = new FormData();
      body.append("file", nextFile);
      if (nextWalFile) body.append("wal", nextWalFile);
      const response = await fetch("/api/laps/detect-import", { method: "POST", body });
      const data = (await response.json().catch(() => null)) as DetectionResult | { error?: string } | null;
      if (!response.ok) {
        const message = data && "error" in data ? data.error : null;
        throw new Error(message ?? `Detection failed (${response.status})`);
      }
      if (!data || !("format" in data)) throw new Error("Detection response was invalid");
      setDetected(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDetecting(false);
    }
  }

  async function importFile() {
    if (!file || !detected?.supported || !["zip", "bin", "duckdb"].includes(detected.format)) return;
    setBusy(true);
    setError(null);
    try {
      let imported: ImportResult;
      if (detected.format === "zip") {
        const response = await importLapsZip(file, ownership);
        imported = { imported: response.imported, skipped: response.skipped };
      } else {
        const body = new FormData();
        body.append("file", file);
        body.append("ownership", ownership);
        if (walFile) body.append("wal", walFile);
        const response = await fetch("/api/laps/import", { method: "POST", body });
        const data = (await response.json().catch(() => null)) as ImportResult & { error?: string };
        if (!response.ok) throw new Error(data?.error ?? `Import failed (${response.status})`);
        imported = data;
      }
      setResult(imported);
      onImported?.(imported);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const canImport = !!file && !!detected?.supported && ["zip", "bin", "duckdb"].includes(detected.format) && !busy;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" showCloseButton={false} overlayClassName="bg-app-bg/60" layout="scrollable" className="max-w-xl">
        <DialogHeader><DialogTitle variant="import">{m.session_import_title()}</DialogTitle></DialogHeader>
        <div className="mt-4 space-y-4 text-xs">
          {result ? (
            <>
              <p className="text-app-text">{m.session_imported({ count: result.imported, skipped: result.skipped ? m.session_skipped({ count: result.skipped }) : "" })}</p>
              <div className="flex justify-end"><Button variant="app-outline" size="app-md" onClick={onClose}>{m.analyse_done()}</Button></div>
            </>
          ) : (
            <>
              <p className="text-app-text-dim">{m.session_choose_file_hint()}</p>
              <OwnershipChoice value={ownership} onChange={setOwnership} disabled={busy} />
              <input
                ref={inputRef}
                type="file"
                accept=".zip,.bin,.bin.gz,.duckdb,.wal,.ibt,.ld"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  const primary = files.find((candidate) => !candidate.name.toLowerCase().endsWith(".wal")) ?? null;
                  const wal = primary ? files.find((candidate) => candidate.name.toLowerCase() === `${primary.name}.wal`.toLowerCase()) ?? null : null;
                  void chooseFile(primary, wal);
                }}
              />
              <div className="flex min-w-0 items-center gap-2">
                <Button variant="app-outline" size="app-md" className="shrink-0" onClick={() => inputRef.current?.click()} disabled={busy}>{m.session_choose_file()}</Button>
                <span className="min-w-0 flex-1 truncate text-app-text-dim" title={file ? `${file.name}${walFile ? ` + ${walFile.name}` : ""}` : undefined}>
                  {file ? `${file.name}${walFile ? ` + ${walFile.name}` : ""}` : m.session_no_file()}
                </span>
              </div>
              {file && (
                <div className="rounded border border-app-border bg-app-surface-alt/40 p-3 text-app-text-dim">
                  {detecting ? <span>{m.session_reading()}</span> : detected ? (
                    <>
                      <div>{m.session_detected({ format: formatLabel(detected.format) })}{detected.gameIds.length > 0 && <span className="text-app-text"> ({detected.gameIds.join(", ")})</span>}</div>
                      {!detected.supported && <p className="mt-1 text-status-warning">{detected.message ?? m.session_unsupported()}</p>}
                      {detected.supported && detected.format === "bin" && <p className="mt-1">{m.session_game_detected()}</p>}
                      {detected.supported && detected.format === "duckdb" && <p className="mt-1">LMU game telemetry will be converted into a normal RaceIQ session capture.</p>}
                      {detected.format === "duckdb" && detected.preview && <p className="mt-1">{detected.preview.carName} at {detected.preview.trackName}: {detected.preview.completedLapCount} complete lap{detected.preview.completedLapCount === 1 ? "" : "s"}.</p>}
                      {detected.format === "duckdb" && !walFile && <p className="mt-1">If a matching <code>.duckdb.wal</code> file exists, select both files together.</p>}
                      {detected.supported && detected.format === "zip" && <p className="mt-1">{m.session_captures_found({ count: detected.captureCount })}</p>}
                      {detected.format === "ibt" && <p className="mt-1">{m.session_ibt_hint()}</p>}
                      {detected.format === "motec" && <p className="mt-1">{m.session_motec_hint()}</p>}
                    </>
                  ) : null}
                </div>
              )}
              {error && <div role="alert" className="rounded border border-status-danger/30 bg-status-danger/5 p-2 text-status-danger">{error}</div>}
              <div className="flex justify-end gap-2">
                <Button variant="app-outline" size="app-md" onClick={onClose} disabled={busy}>{m.common_cancel()}</Button>
                <Button variant="app-outline" size="app-md" onClick={importFile} disabled={!canImport}>{busy ? m.common_loading() : m.setup_import_button()}</Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
