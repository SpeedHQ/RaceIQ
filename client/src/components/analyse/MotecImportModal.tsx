import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionOwnership } from "../../../../shared/racing/sessions/types";
import type { GameId } from "../../../../shared/games/ids";
import { OwnershipChoice } from "../import/OwnershipChoice";
import { useMotecTargets, useCarsFromEndpoint, useTracksForGame } from "../../hooks/catalog-queries";
import type { MotecTargetInfo } from "../../hooks/catalog-queries";
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
  capabilities: readonly {
    semanticId: string;
    label: string;
    group: string;
    available: boolean;
  }[];
  unavailableFeatures: readonly { feature: string; missingSemanticIds: readonly string[] }[];
  limitations: readonly string[];
}





export function formatMotecLapTime(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "—";
  const mm = Math.floor(seconds / 60);
  const ss = (seconds % 60).toFixed(3).padStart(6, "0");
  return `${mm}:${ss}`;
}

export function MotecImportNote({ result, onClose }: { result: MotecImportSuccess; onClose: () => void }) {
  const groups = new Map<string, MotecImportSuccess["capabilities"][number][]>();
  for (const capability of result.capabilities) {
    const entries = groups.get(capability.group) ?? [];
    entries.push(capability);
    groups.set(capability.group, entries);
  }

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col text-xs text-app-text-dim">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <p className="text-app-text">
          Imported <span className="text-app-accent">{result.imported}</span> lap{result.imported === 1 ? "" : "s"} from{" "}
          <span className="text-app-text">{result.meta.venue || "unknown venue"}</span>
          {result.meta.driver ? ` — ${result.meta.driver}` : ""}.
        </p>
        <ul className="space-y-1 font-mono tabular-nums">
          {result.laps.map((lap) => (
            <li key={lap.lapId}>Lap {lap.lapNumber} — {formatMotecLapTime(lap.lapTime)}</li>
          ))}
        </ul>
        <p className="rounded border border-app-border bg-app-surface-alt p-3 text-app-text">
          Use MoTeC imports primarily for approximate racing-line shape and user-input comparison, not as a full substitute for native RaceIQ telemetry.
        </p>
        <div className="rounded border border-status-warning/30 bg-status-warning/5 p-3">
          <div className="mb-2 font-semibold text-status-warning">What this data can and can't tell you</div>
          <ul className="mb-4 list-disc space-y-1 pl-4">
            {result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
          <div className="mb-2 font-semibold text-app-text">Canonical channels</div>
          <div className="space-y-4">
            {[...groups].map(([group, capabilities]) => (
              <section key={group}>
                <h3 className="mb-1 font-semibold text-app-text">{group}</h3>
                <ul className="space-y-1 font-mono">
                  {capabilities.map((capability) => (
                    <li key={capability.semanticId} className="flex items-baseline justify-between gap-4">
                      <span className="flex items-baseline gap-1.5">
                        <span
                          className={capability.available ? "text-status-success" : "text-app-text-dim"}
                          aria-label={capability.available ? "Available" : "Unavailable"}
                          title={capability.available ? "Available" : "Unavailable"}
                        >
                          {capability.available ? "✓" : "×"}
                        </span>
                        <span>{capability.label} <span className="text-app-text-dim">({capability.semanticId})</span></span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 justify-end border-t border-app-border bg-app-surface pt-3">
        <Button variant="app-outline" size="app-md" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
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
 * The game is selected explicitly when this modal is opened outside Analyse.
 * When Analyse supplies a target, its route game remains authoritative.
 */
export function MotecImportModal({
  target: fixedTarget,
  initialGameId,
  initialLd,
  initialLdName,
  initialLdxName,
  stagedToken,
  ownership: controlledOwnership,
  onOwnershipChange,
  onClose,
  onImported,
}: {
  target?: MotecTargetInfo;
  initialGameId?: GameId | null;
  initialLd?: File | null;
  initialLdName?: string;
  initialLdxName?: string;
  stagedToken?: string;
  ownership?: SessionOwnership;
  onOwnershipChange?: (value: SessionOwnership) => void;
  onClose: () => void;
  onImported?: (r: MotecImportSuccess) => void;
}) {
  const { data: targets = [] } = useMotecTargets();
  const [selectedGameId, setSelectedGameId] = useState<GameId | "">(fixedTarget?.gameId ?? initialGameId ?? "");
  const target = fixedTarget ?? targets.find((item) => item.gameId === selectedGameId);
  const [ld, setLd] = useState<File | null>(initialLd ?? null);
  const [ldx, setLdx] = useState<File | null>(null);
  const [carOrdinal, setCarOrdinal] = useState("");
  const [trackOrdinal, setTrackOrdinal] = useState("");
  const [tuneId, setTuneId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localOwnership, setLocalOwnership] = useState<SessionOwnership>("mine");
  const ownership = controlledOwnership ?? localOwnership;
  const handleOwnershipChange = onOwnershipChange ?? setLocalOwnership;
  const [result, setResult] = useState<MotecImportSuccess | null>(null);

  useEffect(() => {
    setCarOrdinal("");
    setTrackOrdinal("");
    setTuneId("");
  }, [target?.gameId]);

  const { data: cars = [] } = useCarsFromEndpoint(target?.carsEndpoint ?? null);
  const { data: tracks = [] } = useTracksForGame(target?.gameId ?? null);
  const { data: tunes = [] } = useUserTunes(target?.gameId);
  const ldRef = useRef<HTMLInputElement>(null);
  const ldxRef = useRef<HTMLInputElement>(null);

  const carOptions = useMemo(() => cars.map((c) => ({ value: String(c.ordinal), label: c.name, group: c.class })), [cars]);
  const trackOptions = useMemo(() => [...tracks].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ value: String(t.ordinal), label: t.variant ? `${t.name} (${t.variant})` : t.name })), [tracks]);
  // Only setups for the chosen car can apply to these laps; before a car is
  // picked there is nothing sensible to offer, so the list stays empty.
  const tuneOptions = useMemo(() => {
    if (!carOrdinal) return [];
    return (tunes as { id: number; name: string; carOrdinal?: number | null }[])
      .filter((t) => t.carOrdinal == null || String(t.carOrdinal) === carOrdinal)
      .map((t) => ({ value: String(t.id), label: t.name }));
  }, [tunes, carOrdinal]);

  const isArchive = ld?.name.toLowerCase().endsWith(".zip") ?? false;
  const canSubmit = !!target && (!!stagedToken || !!ld) && (!!stagedToken || !!ldx) && !!carOrdinal && !!trackOrdinal && !busy;

  async function submit() {
    if (!target || (!ld && !stagedToken) || (!ldx && !stagedToken) || !carOrdinal || !trackOrdinal) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      if (stagedToken) {
        body.append("motecToken", stagedToken);
      } else {
        body.append("file", ld!);
        body.append("ldx", ldx!);
      }
      body.append("gameId", target.gameId);
      body.append("carOrdinal", carOrdinal);
      body.append("trackOrdinal", trackOrdinal);
      if (tuneId) body.append("tuneId", tuneId);
      body.append("ownership", ownership);
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
      <DialogContent size="wide" showCloseButton={false} overlayClassName="bg-app-bg/60" layout="scrollable" className="flex min-h-0 flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle variant="import">Import MoTeC log</DialogTitle>
        </DialogHeader>

        {result ? (
          <MotecImportNote result={result} onClose={onClose} />
        ) : (
          <div className="mt-4 space-y-4 text-xs">
            {!fixedTarget && !initialGameId && (
              <div className="block text-app-text-dim">
                Game
                <SearchSelect
                  value={selectedGameId}
                  onChange={(value) => setSelectedGameId(value as GameId)}
                  options={targets.map((item) => ({ value: item.gameId, label: item.displayName }))}
                  placeholder="Choose game..."
                  className="mt-1"
                />
              </div>
            )}
            <p className="text-app-text-dim">
              {target ? (
                <>Filed as <span className="text-app-text">{target.displayName}</span> — use a log exported by this game; another sim’s channels can import with the wrong meaning instead of failing.</>
              ) : (
                "Choose supported game to load its car and track catalogs."
              )}
            </p>

            <OwnershipChoice value={ownership} onChange={handleOwnershipChange} disabled={busy} />

            {/* Files */}
            <div className="space-y-2">
              <input ref={ldRef} type="file" accept=".ld,.zip" className="hidden" onChange={(e) => setLd(e.target.files?.[0] ?? null)} />
              <input ref={ldxRef} type="file" accept=".ldx" className="hidden" onChange={(e) => setLdx(e.target.files?.[0] ?? null)} />
              <div className="flex items-center gap-2">
                <Button variant="app-outline" size="app-md" onClick={() => ldRef.current?.click()}>
                  Choose .ld or archive
                </Button>
                <span className="truncate text-app-text-dim">{ld?.name ?? initialLdName ?? "No log selected"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="app-outline" size="app-md" onClick={() => ldxRef.current?.click()}>
                  Choose .ldx
                </Button>
                <span className="truncate text-app-text-dim">{ldx?.name ?? initialLdxName ?? (isArchive ? "Included in archive" : "Required — carries the lap beacons")}</span>
              </div>
              {ld && !ldx && !isArchive && !stagedToken && <p className="text-app-text-muted">Select the .ldx signal file before importing.</p>}
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
