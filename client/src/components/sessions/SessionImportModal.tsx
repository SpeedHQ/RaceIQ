import type { SessionOwnership } from "@shared/racing/sessions/types";
import type { GameId } from "@shared/games/ids";
import { useRef, useState } from "react";
import { MotecImportModal, type MotecImportSuccess } from "../analyse/MotecImportModal";
import { OwnershipChoice } from "../import/OwnershipChoice";
import { importLapsZip } from "../../lib/lap-export";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

type DetectedFormat = "zip" | "bin" | "ibt" | "motec" | "unknown";
type DetectionResult = { format: DetectedFormat; supported: boolean; gameIds: string[]; captureCount: number; message: string | null; motecToken?: string; ldName?: string; ldxName?: string };

type ImportResult = {
  imported: number;
  skipped?: number;
  gameId?: string;
  packetCount?: number;
};


function formatLabel(format: DetectedFormat): string {
  switch (format) {
    case "zip":
      return "ZIP archive (.zip)";
    case "bin":
      return "Telemetry capture (.bin)";
    case "ibt":
      return "iRacing telemetry (.ibt)";
    case "motec":
      return "MoTeC log (.ld)";
    default:
      return "Unknown file format";
  }
}

export function SessionImportModal({ gameId, onClose, onImported }: { gameId?: GameId | null; onClose: () => void; onImported?: (result: ImportResult) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<DetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [ownership, setOwnership] = useState<SessionOwnership>("mine");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function chooseFile(nextFile: File | null) {
    const previousToken = detected?.motecToken;
    if (previousToken) void fetch("/api/laps/cancel-motec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: previousToken }) });
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
      if (detection.format === "motec" && nextFile.name.toLowerCase().endsWith(".zip")) {
        setExtracting(true);
        const stageBody = new FormData();
        stageBody.append("file", nextFile);
        const stageResponse = await fetch("/api/laps/stage-motec", { method: "POST", body: stageBody });
        const staged = await stageResponse.json().catch(() => null) as { token?: string; ldName?: string; ldxName?: string; error?: string } | null;
        if (!stageResponse.ok || !staged?.token) throw new Error(staged?.error ?? `MoTeC extraction failed (${stageResponse.status})`);
        setDetected({ ...detection, motecToken: staged.token, ldName: staged.ldName, ldxName: staged.ldxName });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDetecting(false);
      setExtracting(false);
    }
  }
  function closeImport() {
    const token = detected?.motecToken;
    if (token) void fetch("/api/laps/cancel-motec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
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
  if (detected?.format === "motec" && file && (!file.name.toLowerCase().endsWith(".zip") || !!detected.motecToken)) {
    return (
      <MotecImportModal
        initialGameId={gameId}
        initialLd={file.name.toLowerCase().endsWith(".zip") ? null : file}
        initialLdName={detected.ldName}
        initialLdxName={detected.ldxName}
        stagedToken={detected.motecToken}
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
          <DialogTitle variant="import">Import session data</DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4 text-xs">
          {result ? (
            <>
              <p className="text-app-text">
                Imported <span className="text-app-accent">{result.imported}</span> lap{result.imported === 1 ? "" : "s"}.
                {result.skipped ? ` Skipped ${result.skipped}.` : ""}
              </p>
              <div className="flex justify-end">
                <Button variant="app-outline" size="app-md" onClick={closeImport}>Done</Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-app-text-dim">Choose a file. Format and game metadata are checked from its contents.</p>
              <OwnershipChoice value={ownership} onChange={setOwnership} disabled={busy} />
              <input ref={inputRef} type="file" accept=".zip,.bin,.bin.gz,.ibt,.ld" className="hidden" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
              <div className="flex items-center gap-2">
                <Button variant="app-outline" size="app-md" onClick={() => inputRef.current?.click()} disabled={busy}>Choose file</Button>
                <span className="truncate text-app-text-dim">{file?.name ?? "No file selected"}</span>
              </div>
              {file && (
                <div className="rounded border border-app-border bg-app-surface-alt/40 p-3 text-app-text-dim">
                  {extracting ? (
                    <span className="flex items-center gap-2"><span className="inline-block size-2 animate-pulse rounded-full bg-app-accent" />MoTeC archive detected — extracting…</span>
                  ) : detecting ? (
                    <span>Reading file contents…</span>
                  ) : detected ? (
                    <>
                      <div>
                        Detected: <span className="text-app-text">{formatLabel(detected.format)}</span>
                        {detected.gameIds.length > 0 && <span className="text-app-text"> ({detected.gameIds.join(", ")})</span>}
                      </div>
                      {!detected.supported && <p className="mt-1 text-status-warning">{detected.message ?? "File contents are not supported."}</p>}
                      {detected.supported && detected.format === "bin" && <p className="mt-1">Game detected from telemetry content.</p>}
                      {detected.supported && detected.format === "zip" && <p className="mt-1">{detected.captureCount} RaceIQ capture{detected.captureCount === 1 ? "" : "s"} found.</p>}
                      {detected.format === "ibt" && <p className="mt-1">iRacing imports require preview and confirmation from Analyse.</p>}
                      {detected.format === "motec" && <p className="mt-1">MoTeC imports require game, car, and track setup from Analyse.</p>}
                    </>
                  ) : null}
                </div>
              )}
              {error && <div role="alert" className="rounded border border-status-danger/30 bg-status-danger/5 p-2 text-status-danger">{error}</div>}
              <div className="flex justify-end gap-2">
                <Button variant="app-outline" size="app-md" onClick={closeImport} disabled={busy}>Cancel</Button>
                <Button variant="app-outline" size="app-md" onClick={importFile} disabled={!canImport}>{busy ? "Importing…" : "Import"}</Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
