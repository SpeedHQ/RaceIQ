import { useMemo, useRef, useState } from "react";
import type { GameId } from "../../../../shared/games/ids";
import { useCarsFromEndpoint, useMotecTargets, useTracksForGame } from "../../hooks/catalog-queries";
import { useUserTunes } from "../../hooks/tunes";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { SearchSelect } from "../ui/SearchSelect";
export interface MotecImportedLap {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  trackOrdinal: number;
}

export interface MotecImportSuccess {
  imported: number;
  gameId: string;
  routePrefix: string;
  laps: MotecImportedLap[];
  meta: { driver: string; venue: string; vehicleId: string; [k: string]: unknown };
  limitations: readonly string[];
}

function fmtLapTime(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const mm = Math.floor(totalSec / 60);
  const ss = (totalSec % 60).toFixed(3).padStart(6, "0");
  return `${mm}:${ss}`;
}

/**
 * "Import MoTeC log" dialog.
 *
 * Car and track are required and deliberately the *user's* call rather than
 * read off the log header: MoTeC's venue/vehicle strings are free text set by
 * whoever configured the exporter, and a log filed against the wrong track
 * silently produces meaningless sectors and corner names. The setup is
 * optional — not knowing it costs a label and nothing else.
 *
 * The `.ldx` sidecar carries the lap beacons. Without it the log imports as
 * one unsplit stint, which is the right answer for a standalone hotlap export
 * but wrong for a full session, hence the inline note rather than a hard
 * requirement.
 *
 * The game is asked of the server (`/api/motec/targets`) — a `.ld` names no
 * sim, and each one's exporter scales channels differently, so which game the
 * log came from is the user's call among the transcoders that exist. While
 * there is only one the picker stays hidden and the dialog states the
 * assumption instead.
 */
export function MotecImportModal({ onClose, onImported }: { onClose: () => void; onImported?: (r: MotecImportSuccess) => void }) {
  const ldRef = useRef<HTMLInputElement>(null);
  const ldxRef = useRef<HTMLInputElement>(null);
  const [ld, setLd] = useState<File | null>(null);
  const [ldx, setLdx] = useState<File | null>(null);
  const [gameId, setGameId] = useState<GameId | "">("");
  const [carOrdinal, setCarOrdinal] = useState("");
  const [trackOrdinal, setTrackOrdinal] = useState("");
  const [tuneId, setTuneId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MotecImportSuccess | null>(null);

  const { data: targets = [] } = useMotecTargets();
  // Single target = no decision to make; auto-select so the picker can stay
  // hidden until a second transcoder lands.
  const effectiveGameId: GameId | "" = gameId || (targets.length === 1 ? targets[0].gameId : "");
  const target = targets.find((t) => t.gameId === effectiveGameId) ?? null;

  const { data: cars = [] } = useCarsFromEndpoint(target?.carsEndpoint ?? null);
  const { data: tracks = [] } = useTracksForGame(effectiveGameId || null);
  const { data: tunes = [] } = useUserTunes(effectiveGameId || undefined);

  const carOptions = useMemo(() => cars.map((c) => ({ value: String(c.ordinal), label: c.name, group: c.class })), [cars]);
  const trackOptions = useMemo(() => [...tracks].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ value: String(t.ordinal), label: t.name })), [tracks]);
  // Only setups for the chosen car can apply to these laps; before a car is
  // picked there is nothing sensible to offer, so the list stays empty.
  const tuneOptions = useMemo(() => {
    if (!carOrdinal) return [];
    return (tunes as { id: number; name: string; carOrdinal?: number | null }[])
      .filter((t) => t.carOrdinal == null || String(t.carOrdinal) === carOrdinal)
      .map((t) => ({ value: String(t.id), label: t.name }));
  }, [tunes, carOrdinal]);

  const canSubmit = !!ld && !!effectiveGameId && !!carOrdinal && !!trackOrdinal && !busy;

  async function submit() {
    if (!ld || !effectiveGameId || !carOrdinal || !trackOrdinal) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", ld);
      if (ldx) body.append("ldx", ldx);
      body.append("gameId", effectiveGameId);
      body.append("carOrdinal", carOrdinal);
      body.append("trackOrdinal", trackOrdinal);
      if (tuneId) body.append("tuneId", tuneId);
      // Multipart upload — no RPC binding for form bodies, same as
      // /api/laps/import and /api/laps/import-zip.
      const res = await fetch("/api/laps/import-motec", { method: "POST", body });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ? `${data.error}${data.details ? `: ${data.details}` : ""}` : `Import failed (${res.status})`);
        return;
      }
      const success = data as MotecImportSuccess;
      setResult(success);
      onImported?.(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" showCloseButton={false} overlayClassName="bg-app-bg/60" layout="scrollable" className="max-w-xl">
        <DialogHeader>
          <DialogTitle variant="import">Import MoTeC log</DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="mt-4 space-y-3 text-xs text-app-text-dim">
            <p className="text-app-text">
              Imported <span className="text-app-accent">{result.imported}</span> lap{result.imported === 1 ? "" : "s"} from{" "}
              <span className="text-app-text">{result.meta.venue || "unknown venue"}</span>
              {result.meta.driver ? ` — ${result.meta.driver}` : ""}.
            </p>
            <ul className="space-y-1 font-mono tabular-nums">
              {result.laps.map((l) => (
                <li key={l.lapId}>
                  Lap {l.lapNumber} — {fmtLapTime(l.lapTime)}
                </li>
              ))}
            </ul>
          <div className="rounded border border-status-warning/30 bg-status-warning/5 p-3">
            <div className="mb-1 font-semibold text-status-warning">What this data can and can't tell you</div>
              <ul className="list-disc space-y-1 pl-4">
                {result.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end">
              <Button variant="app-outline" size="app-md" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4 text-xs">
            {targets.length > 1 ? (
              <div className="block text-app-text-dim">
                Game
                <SearchSelect
                  value={effectiveGameId}
                  onChange={(v) => {
                    setGameId(v as GameId);
                    // Car/track/setup ordinals are per-game; carrying them
                    // across would file the log against another sim's track.
                    setCarOrdinal("");
                    setTrackOrdinal("");
                    setTuneId("");
                  }}
                  options={targets.map((t) => ({ value: t.gameId, label: t.displayName }))}
                  placeholder="Which sim exported this log?"
                  className="mt-1"
                />
              </div>
            ) : (
              <p className="text-app-text-dim">
                Filed as <span className="text-app-text">{target?.displayName ?? "…"}</span> — the channel mapping is only verified against that game's export, so logs from other sims would import
                wrong rather than fail.
              </p>
            )}

            {/* Files */}
            <div className="space-y-2">
              <input ref={ldRef} type="file" accept=".ld" className="hidden" onChange={(e) => setLd(e.target.files?.[0] ?? null)} />
              <input ref={ldxRef} type="file" accept=".ldx" className="hidden" onChange={(e) => setLdx(e.target.files?.[0] ?? null)} />
              <div className="flex items-center gap-2">
                <Button variant="app-outline" size="app-md" onClick={() => ldRef.current?.click()}>
                  Choose .ld
                </Button>
                <span className="truncate text-app-text-dim">{ld?.name ?? "No log selected"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="app-outline" size="app-md" onClick={() => ldxRef.current?.click()}>
                  Choose .ldx
                </Button>
                <span className="truncate text-app-text-dim">{ldx?.name ?? "Optional — carries the lap beacons"}</span>
              </div>
              {ld && !ldx && <p className="text-app-text-muted">Without the .ldx sidecar the log imports as a single unsplit stint.</p>}
            </div>

            {/* Car / track / setup */}
            <div className="space-y-2">
              <div className="block text-app-text-dim">
                Car
                <SearchSelect value={carOrdinal} onChange={setCarOrdinal} options={carOptions} placeholder="Search cars..." className="mt-1" />
              </div>
              <div className="block text-app-text-dim">
                Track
                <SearchSelect value={trackOrdinal} onChange={setTrackOrdinal} options={trackOptions} placeholder="Search tracks..." className="mt-1" />
              </div>
              <div className="block text-app-text-dim">
                Setup <span className="text-app-text-muted">(optional)</span>
                <SearchSelect value={tuneId} onChange={setTuneId} options={tuneOptions} placeholder={carOrdinal ? "Search setups..." : "Pick a car first"} disabled={!carOrdinal} className="mt-1" />
              </div>
              <p className="text-app-text-muted">
                MoTeC's own venue and vehicle strings are free text set by whoever configured the exporter, so car and track are your call — filing a log against the wrong track gives it meaningless
                sectors and corner names.
              </p>
            </div>

          {error && <div className="rounded border border-status-danger/30 bg-status-danger/5 p-2 text-status-danger">{error}</div>}

            <div className="flex justify-end gap-2">
              <Button variant="app-outline" size="app-md" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="app-outline" size="app-md" onClick={submit} disabled={!canSubmit}>
                {busy ? "Importing…" : "Import"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
