import type { SessionOwnership } from "@shared/racing/sessions/types";
import type { GameId } from "@shared/games/ids";
import { useRef, useState } from "react";
import { MotecImportModal, type MotecImportSuccess } from "../analyse/MotecImportModal";
import { OwnershipChoice } from "../import/OwnershipChoice";
import { importLapsZip } from "../../lib/lap-export";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { m } from "../../paraglide/messages";

type DetectedFormat = "zip" | "bin" | "ibt" | "motec" | "unknown";
type DetectionResult = { format: DetectedFormat; supported: boolean; gameIds: string[]; captureCount: number; message: string | null };

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
    case "ibt": return m.session_format_ibt();
    case "motec": return m.session_format_motec();
    default: return m.session_format_unknown();
  }
}

export function SessionImportModal({ gameId, onClose, onImported }: { gameId?: GameId | null; onClose: () => void; onImported?: (result: ImportResult) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<DetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [ownership, setOwnership] = useState<SessionOwnership>("mine");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function chooseFile(nextFile: File | null) {
    setFile(nextFile);
    setDetected(null);
    setError(null);
    setResult(null);
    if (!nextFile) return;
    setDetecting(true);
    try {
      const body = new FormData();
      body.append("file", nextFile);
      const response = await fetch("/api/laps/detect-import", { method: "POST", body });
      const data = (await response.json().catch(() => null)) as DetectionResult | { error?: string } | null;
      if (!response.ok) {
        const message = data && "error" in data ? data.error : null;
        throw new Error(message ?? `Detection failed (${response.status})`);
      }
      if (!data || !("format" in data)) throw new Error("Detection response was invalid");
      const detection = data as DetectionResult;
      setDetected(detection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDetecting(false);
    }
  }
  function closeImport() {
    onClose();
  }
  async function importFile() {
    if (!file || !detected?.supported || (detected.format !== "zip" && detected.format !== "bin")) return;
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

  const canImport = !!file && !!detected?.supported && (detected.format === "zip" || detected.format === "bin") && !busy;
  if (detected?.format === "motec" && file) {
    return (
      <MotecImportModal
        initialGameId={gameId}
        initialLd={file}
        ownership={ownership}
        onOwnershipChange={setOwnership}
        onClose={closeImport}
        onImported={(motecResult: MotecImportSuccess) => onImported?.({ imported: motecResult.imported, gameId: motecResult.gameId })}
      />
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && closeImport()}>
      <DialogContent size="lg" showCloseButton={false} overlayClassName="bg-app-bg/60" layout="scrollable" className="max-w-xl">
        <DialogHeader>
          <DialogTitle variant="import">{m.session_import_title()}</DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4 text-xs">
          {result ? (
            <>
            <p className="text-app-text">{m.session_imported({ count: result.imported, skipped: result.skipped ? m.session_skipped({ count: result.skipped }) : "" })}</p>
            <div className="flex justify-end">
              <Button variant="app-outline" size="app-md" onClick={closeImport}>{m.analyse_done()}</Button>
            </div>
            </>
          ) : (
            <>
              <p className="text-app-text-dim">{m.session_choose_file_hint()}</p>
              <OwnershipChoice value={ownership} onChange={setOwnership} disabled={busy} />
              <input ref={inputRef} type="file" accept=".zip,.bin,.bin.gz,.ibt,.ld" className="hidden" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
              <div className="flex items-center gap-2">
                <Button variant="app-outline" size="app-md" onClick={() => inputRef.current?.click()} disabled={busy}>
                  {m.session_choose_file()}
                </Button>
                <span className="truncate text-app-text-dim">{file?.name ?? m.session_no_file()}</span>
              </div>
              {file && (
                <div className="rounded border border-app-border bg-app-surface-alt/40 p-3 text-app-text-dim">
                  {detecting ? (
                    <span>{m.session_reading()}</span>
                  ) : detected ? (
                    <>
                      <div>
                        {m.session_detected({ format: formatLabel(detected.format) })}
                        {detected.gameIds.length > 0 && <span className="text-app-text"> ({detected.gameIds.join(", ")})</span>}
                      </div>
                      {!detected.supported && <p className="mt-1 text-status-warning">{detected.message ?? m.session_unsupported()}</p>}
                      {detected.supported && detected.format === "bin" && <p className="mt-1">{m.session_game_detected()}</p>}
                      {detected.supported && detected.format === "zip" && (
                        <p className="mt-1">
                          {m.session_captures_found({ count: detected.captureCount })}
                        </p>
                      )}
                      {detected.format === "ibt" && <p className="mt-1">{m.session_ibt_hint()}</p>}
                      {detected.format === "motec" && <p className="mt-1">{m.session_motec_hint()}</p>}
                    </>
                  ) : null}
                </div>
              )}
              {error && (
                <div role="alert" className="rounded border border-status-danger/30 bg-status-danger/5 p-2 text-status-danger">
                  {error}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="app-outline" size="app-md" onClick={closeImport} disabled={busy}>
                  {m.common_cancel()}
                </Button>
                <Button variant="app-outline" size="app-md" onClick={importFile} disabled={!canImport}>
                  {busy ? m.common_loading() : m.setup_import_button()}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
