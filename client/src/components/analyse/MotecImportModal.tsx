import { useEffect, useMemo, useRef, useState } from "react";
import { analyseSemanticIds } from "../../../../shared/games/metric-contracts";
import { getGame } from "../../../../shared/games/registry";
import { TELEMETRY_CATALOG } from "../../../../shared/telemetry/catalog/data";
import type { SemanticAnalysisFrame } from "./track-map/types";
import type { SessionOwnership } from "../../../../shared/racing/sessions/types";
import type { GameId } from "../../../../shared/games/ids";
import { OwnershipChoice } from "../import/OwnershipChoice";
import { useMotecTargets, useCarsFromEndpoint, useTracksForGame } from "../../hooks/catalog-queries";
import type { MotecTargetInfo } from "../../hooks/catalog-queries";
import { useUserTunes } from "../../hooks/tunes";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { SearchSelect } from "../ui/SearchSelect";
import { formatMotecLapTime, hasCompleteMotecSource } from "./motec-import-utils";
export interface MotecImportedLap {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  trackOrdinal: number;
}

export interface MotecCapability {
  semanticId: string;
  label: string;
  group: string;
  available: boolean;
}

export interface MotecImportSuccess {
  imported: number;
  gameId: string;
  routePrefix: string;
  laps: MotecImportedLap[];
  meta: { driver: string; venue: string; vehicleId: string; [k: string]: unknown };
  capabilities: readonly MotecCapability[];
  unavailableFeatures: readonly { feature: string; missingSemanticIds: readonly string[] }[];
  limitations: readonly string[];
}
export interface MotecMetricAvailability {
  semanticId: string;
  label: string;
  group: string;
}

export function buildMotecMetricAvailability({
  frame,
  gameId,
}: {
  frame: Pick<SemanticAnalysisFrame, "values" | "states">;
  gameId: GameId;
}): { available: MotecMetricAvailability[]; unavailable: MotecMetricAvailability[] } {
  const adapter = getGame(gameId);
  const availableIds = new Set(
    analyseSemanticIds(adapter).filter((semanticId) => frame.states[semanticId] === "ok" || frame.values[semanticId] != null),
  );
  const metrics = analyseSemanticIds(adapter).map((semanticId) => {
    const variable = TELEMETRY_CATALOG.variables.find((candidate) => candidate.id === semanticId);
    return {
      semanticId,
      label: variable?.label ?? semanticId,
      group: TELEMETRY_CATALOG.groups.find((candidate) => candidate.id === variable?.parentId)?.label ?? "Other",
    };
  });
  return {
    available: metrics.filter(({ semanticId }) => availableIds.has(semanticId)),
    unavailable: metrics.filter(({ semanticId }) => !availableIds.has(semanticId)),
  };
}





function MotecImportCapabilityContent({
  capabilities,
  limitations,
}: {
  capabilities: readonly MotecCapability[];
  limitations: readonly string[];
}) {
  const groups = new Map<string, MotecCapability[]>();
  for (const capability of capabilities) groups.set(capability.group, [...(groups.get(capability.group) ?? []), capability]);
  return <>
    <p className="rounded border border-app-border bg-app-surface-alt p-3 text-app-text">
      Use MoTeC imports primarily for approximate racing-line shape and user-input comparison, not as a full substitute for native RaceIQ telemetry.
    </p>
    <div className="rounded border border-status-warning/30 bg-status-warning/5 p-3">
      <div className="mb-2 font-semibold text-status-warning">What this data can and can't tell you</div>
      <ul className="mb-4 list-disc space-y-1 pl-4">
        {limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
      </ul>
      <div className="mb-2 font-semibold text-app-text">Canonical channels</div>
      <div className="space-y-4">
        {[...groups].map(([group, groupCapabilities]) => (
          <section key={group}>
            <h3 className="mb-1 font-semibold text-app-text">{group}</h3>
            <ul className="space-y-1 font-mono">
              {groupCapabilities.map((capability) => <li key={capability.semanticId} className="flex items-baseline justify-between gap-4"><span className="flex items-baseline gap-1.5"><span className={capability.available ? "text-status-success" : "text-app-text-dim"} aria-label={capability.available ? "Available" : "Unavailable"} title={capability.available ? "Available" : "Unavailable"}>{capability.available ? "✓" : "×"}</span><span>{capability.label} <span className="text-app-text-dim">({capability.semanticId})</span></span></span></li>)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  </>;
}



export function MotecMetricInfoModal({
  frame,
  gameId,
  onClose,
}: {
  frame: Pick<SemanticAnalysisFrame, "values" | "states">;
  gameId: GameId;
  onClose: () => void;
}) {
  const availability = buildMotecMetricAvailability({ frame, gameId });
  const { data: targets = [] } = useMotecTargets();
  const limitations = targets.find((target) => target.gameId === gameId)?.limitations ?? [];
  const capabilities: MotecCapability[] = [...availability.available, ...availability.unavailable].map((metric) => ({
    ...metric,
    available: availability.available.some(({ semanticId }) => semanticId === metric.semanticId),
  }));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" layout="scrollable" overlayClassName="bg-app-bg/60" className="flex min-h-0 flex-col overflow-hidden">
        <DialogHeader><DialogTitle className="text-app-heading font-semibold">MoTeC import info</DialogTitle></DialogHeader>
        <div className="mt-4 flex min-h-0 flex-1 flex-col text-xs text-app-text-dim">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <MotecImportCapabilityContent capabilities={capabilities} limitations={limitations} />
          </div>
          <div className="flex shrink-0 justify-end border-t border-app-border bg-app-surface pt-3"><Button variant="app-outline" size="app-md" onClick={onClose}>Done</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function MotecImportNote({ result, onClose }: { result: MotecImportSuccess; onClose: () => void }) {
  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col text-xs text-app-text-dim">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <p className="text-app-text">
          Imported <span className="text-app-accent">{result.imported}</span> lap{result.imported === 1 ? "" : "s"} from{" "}
          <span className="text-app-text">{result.meta.venue || "unknown venue"}</span>
          {result.meta.driver ? ` — ${result.meta.driver}` : ""}.
        </p>
        <ul className="space-y-1 font-mono tabular-nums">
          {result.laps.map((lap) => <li key={lap.lapId}>Lap {lap.lapNumber} — {formatMotecLapTime(lap.lapTime)}</li>)}
        </ul>
        <MotecImportCapabilityContent capabilities={result.capabilities} limitations={result.limitations} />
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
 * The `.ldx` sidecar carries lap beacons and is required beside a standalone
 * `.ld` upload. A `.zip` upload is staged into a temporary directory first;
 * the extracted `.ld` and `.ldx` names are shown before import.
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
  const [archiveToken, setArchiveToken] = useState(stagedToken ?? "");
  const [archiveNames, setArchiveNames] = useState({ ld: initialLdName ?? "", ldx: initialLdxName ?? "" });
  const [archiveStatus, setArchiveStatus] = useState<"idle" | "extracting" | "ready" | "error">(stagedToken ? "ready" : "idle");
  const [carOrdinal, setCarOrdinal] = useState("");
  const [trackOrdinal, setTrackOrdinal] = useState("");
  const [tuneId, setTuneId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localOwnership, setLocalOwnership] = useState<SessionOwnership>("mine");
  const ownership = controlledOwnership ?? localOwnership;
  const handleOwnershipChange = onOwnershipChange ?? setLocalOwnership;
  const [result, setResult] = useState<MotecImportSuccess | null>(null);
  const stagedTokenRef = useRef(archiveToken);
  const archiveRequestRef = useRef(0);
  const initialArchiveStartedRef = useRef(false);
  const { data: cars = [] } = useCarsFromEndpoint(target?.carsEndpoint ?? null);
  const { data: tracks = [] } = useTracksForGame(target?.gameId ?? null);
  const { data: tunes = [] } = useUserTunes(target?.gameId);
  const ldRef = useRef<HTMLInputElement>(null);
  const ldxRef = useRef<HTMLInputElement>(null);

  async function cancelStagedToken(token: string) {
    if (!token) return;
    await fetch("/api/laps/cancel-motec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => undefined);
  }

  async function stageArchive(file: File) {
    const requestId = ++archiveRequestRef.current;
    const previousToken = stagedTokenRef.current;
    stagedTokenRef.current = "";
    setArchiveToken("");
    setArchiveNames({ ld: "", ldx: "" });
    setArchiveStatus("extracting");
    setError(null);
    await cancelStagedToken(previousToken);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/laps/stage-motec", { method: "POST", body });
      const data = await response.json().catch(() => null) as { token?: string; ldName?: string; ldxName?: string; error?: string } | null;
      if (!response.ok || !data?.token || !data.ldName || !data.ldxName) {
        throw new Error(data?.error ?? `Archive extraction failed (${response.status})`);
      }
      if (requestId !== archiveRequestRef.current) {
        await cancelStagedToken(data.token);
        return;
      }
      stagedTokenRef.current = data.token;
      setArchiveToken(data.token);
      setArchiveNames({ ld: data.ldName, ldx: data.ldxName });
      setArchiveStatus("ready");
    } catch (cause) {
      if (requestId !== archiveRequestRef.current) return;
      setArchiveStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function chooseLd(file: File | null) {
    setLd(file);
    setLdx(null);
    if (file?.name.toLowerCase().endsWith(".zip")) {
      void stageArchive(file);
    } else {
      const token = stagedTokenRef.current;
      stagedTokenRef.current = "";
      setArchiveToken("");
      setArchiveNames({ ld: "", ldx: "" });
      setArchiveStatus("idle");
      void cancelStagedToken(token);
    }
  }

  useEffect(() => {
    if (!initialLd || !initialLd.name.toLowerCase().endsWith(".zip") || initialArchiveStartedRef.current) return;
    initialArchiveStartedRef.current = true;
    void stageArchive(initialLd);
    return () => {
      const token = stagedTokenRef.current;
      stagedTokenRef.current = "";
      void cancelStagedToken(token);
    };
  }, [initialLd]);

  useEffect(() => () => {
    const token = stagedTokenRef.current;
    void cancelStagedToken(token);
  }, []);


  const chooseGame = (value: string) => {
    setSelectedGameId(value as GameId);
    setCarOrdinal("");
    setTrackOrdinal("");
    setTuneId("");
  };

  const carOptions = useMemo(() => cars.map((c) => ({ value: String(c.ordinal), label: c.name, group: c.class })), [cars]);
  const trackOptions = useMemo(() => tracks.toSorted((a, b) => a.name.localeCompare(b.name)).map((t) => ({ value: String(t.ordinal), label: t.variant ? `${t.name} (${t.variant})` : t.name })), [tracks]);
  // Only setups for the chosen car can apply to these laps; before a car is
  // picked there is nothing sensible to offer, so the list stays empty.
  const tuneOptions = useMemo(() => {
    if (!carOrdinal) return [];
    return (tunes as { id: number; name: string; carOrdinal?: number | null }[])
      .filter((t) => t.carOrdinal == null || String(t.carOrdinal) === carOrdinal)
      .map((t) => ({ value: String(t.id), label: t.name }));
  }, [tunes, carOrdinal]);

  const isArchive = ld?.name.toLowerCase().endsWith(".zip") ?? false;
  const canSubmit = !!target && hasCompleteMotecSource(ld, ldx, archiveToken) && (!isArchive || archiveStatus === "ready") && !!carOrdinal && !!trackOrdinal && !busy;

  async function submit() {
    if (!target || !hasCompleteMotecSource(ld, ldx, archiveToken) || (isArchive && archiveStatus !== "ready") || !carOrdinal || !trackOrdinal) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      if (archiveToken) {
        body.append("motecToken", archiveToken);
      } else {
        body.append("file", ld!);
        if (ldx) body.append("ldx", ldx);
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
                  onChange={chooseGame}
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
              <input ref={ldRef} type="file" accept=".ld,.zip" className="hidden" onChange={(e) => chooseLd(e.target.files?.[0] ?? null)} />
              <input ref={ldxRef} type="file" accept=".ldx" className="hidden" onChange={(e) => setLdx(e.target.files?.[0] ?? null)} />
              <div className="flex items-center gap-2">
                <Button variant="app-outline" size="app-md" onClick={() => ldRef.current?.click()} disabled={busy || archiveStatus === "extracting"}>
                  Choose .ld or archive
                </Button>
                <span className="truncate text-app-text-dim">{isArchive ? archiveNames.ld || ld?.name : ld?.name ?? initialLdName ?? "No log selected"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="app-outline" size="app-md" onClick={() => ldxRef.current?.click()} disabled={busy || isArchive}>
                  Choose .ldx
                </Button>
                <span className="truncate text-app-text-dim">{isArchive ? archiveNames.ldx || "Waiting for archive extraction…" : ldx?.name ?? initialLdxName ?? "Required — carries the lap beacons"}</span>
              </div>
              {(archiveStatus === "extracting" || archiveStatus === "error") && (
                <p className={archiveStatus === "error" ? "text-status-danger" : "text-app-text-muted"}>
                  {archiveStatus === "extracting" ? "Extracting archive to temporary storage…" : "Archive extraction failed."}
                </p>
              )}
              {ld && !ldx && !isArchive && !archiveToken && <p className="text-app-text-muted">Select the .ldx signal file before importing.</p>}
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
