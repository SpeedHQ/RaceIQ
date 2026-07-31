import { useCallback, useEffect, useRef, useState } from "react";
import { type AutoTuneResult, useAutoTune, useSetupFiles } from "../../hooks/queries";
import { Button } from "../ui/button";

/**
 * useSetupEngineer — owns the Setup Engineer (symptom→intent→apply) request
 * state so the controls (setup file + Recommend/Apply) and the results can live
 * in different parts of the layout, or be reused by the live panel. `lapId` is
 * passed at call time, not held here, so the parent decides which lap runs.
 */
export function useSetupEngineer(gameId: "acc" | "ac-evo", trackName?: string) {
  const [filePath, setFilePath] = useState<string>("");
  const [driverNotes, setDriverNotes] = useState<string>("");
  const [result, setResult] = useState<AutoTuneResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: setupFiles, isLoading: loadingFiles } = useSetupFiles(gameId);
  const autoTune = useAutoTune();
  // The lap the current recommendation is for, so Apply can reuse it without
  // the caller threading the lap id through the results UI.
  const lastLapRef = useRef<number | null>(null);
  // Snapshot the notes used for the current recommendation so Apply re-sends the
  // same feel input the preview was computed from.
  const lastNotesRef = useRef<string>("");

  const runPreviewFor = useCallback(
    async (lapId: number) => {
      if (!filePath) return; // a base setup is required
      lastLapRef.current = lapId;
      const notes = driverNotes.trim() || undefined;
      lastNotesRef.current = notes ?? "";
      setError(null);
      setResult(null);
      try {
        setResult(await autoTune.mutateAsync({ gameId, stintId: lapId, filePath, trackName, preview: true, driverNotes: notes }));
      } catch (err: any) {
        setError(err?.message ?? "Setup Engineer failed");
      }
    },
    [gameId, filePath, trackName, driverNotes, autoTune],
  );

  const applyToFile = useCallback(
    async (saveAsName?: string, overwrite?: boolean) => {
      const lapId = lastLapRef.current;
      if (lapId == null || !filePath) return;
      const notes = lastNotesRef.current || undefined;
      setError(null);
      try {
        setResult(await autoTune.mutateAsync({ gameId, stintId: lapId, filePath, trackName, preview: false, saveAsName, overwrite, driverNotes: notes }));
      } catch (err: any) {
        setError(err?.message ?? "Setup Engineer failed");
      }
    },
    [gameId, filePath, trackName, autoTune],
  );

  return { filePath, setFilePath, driverNotes, setDriverNotes, setupFiles, loadingFiles, result, error, isPending: autoTune.isPending, runPreviewFor, applyToFile };
}

export type SetupEngineerState = ReturnType<typeof useSetupEngineer>;

/** Base-setup picker + Recommend button — compact, for a toolbar. A base setup
 *  is required (ACC/AC-EVO only expose saved setups). Applying (writing a named
 *  setup file) happens in the results, after review. */
export function SetupEngineerControls({ state, lapId }: { state: SetupEngineerState; lapId?: number }) {
  const { filePath, setFilePath, driverNotes, setDriverNotes, setupFiles, loadingFiles, isPending, runPreviewFor } = state;
  const noFiles = !loadingFiles && !setupFiles?.files?.length;
  return (
    <div className="flex items-center gap-2">
      <select
        className="bg-app-dropdown border border-app-border rounded px-2 py-1 text-app-detail max-w-[220px]"
        value={filePath}
        onChange={(e) => setFilePath(e.target.value)}
        disabled={loadingFiles || noFiles}
        title="Base setup — the saved in-game setup to build on (required)"
      >
        <option value="">{loadingFiles ? "Loading setups…" : noFiles ? "No saved setups found" : "Base setup (required)…"}</option>
        {setupFiles?.files?.map((f) => (
          <option key={f.absolutePath} value={f.absolutePath}>
            {f.carModel} / {f.trackName} / {f.fileName}
          </option>
        ))}
      </select>
      <input
        value={driverNotes}
        onChange={(e) => setDriverNotes(e.target.value)}
        placeholder="How does it feel? (optional)"
        maxLength={500}
        title="Driver feel — biases the recommendation, never overrides telemetry. e.g. 'loose on entry', 'understeer in slow hairpins'"
        className="bg-app-dropdown border border-app-border rounded px-2 py-1 text-xs w-[200px]"
      />
      <Button
        type="button"
        variant="app-primary"
        size="app-sm"
        onClick={() => lapId != null && runPreviewFor(lapId)}
        disabled={lapId == null || isPending || !filePath}
        title={!filePath ? "Pick a base setup first" : undefined}
        className="!h-auto"
      >
        {isPending ? "Analysing…" : "Recommend"}
      </Button>
    </div>
  );
}

/** Prompt shown when no saved setups exist — the driver must create one in-game
 *  first, since ACC/AC-EVO don't expose a default setup file. */
export function NoSetupsHint({ state }: { state: SetupEngineerState }) {
  if (state.loadingFiles || state.setupFiles?.files?.length) return null;
  return (
    <div className="text-xs text-status-warning border border-status-warning/30 bg-status-warning/10 rounded px-2 py-1.5">
      No saved setups found. In-game, open <span className="font-mono">Setup → Save</span> (even the default) so Setup Engineer has a base to build on — it'll appear here automatically.
    </div>
  );
}

/** Setup Engineer results: findings, AI intents, and (with a base setup) a
 *  save-as-new-file Apply step so the original setup is never overwritten. */
export function SetupEngineerResult({ state }: { state: SetupEngineerState }) {
  const { result, error, filePath, isPending, applyToFile } = state;
  const [saveAs, setSaveAs] = useState("");

  // Suggest a filename once a preview with a base setup lands (unless applied).
  useEffect(() => {
    if (result && result.hasSetup !== false && !result.written) {
      setSaveAs((cur) => cur || suggestName(filePath));
    }
  }, [result, filePath]);

  const canApply = !!result && result.hasSetup !== false && !result.written;

  return (
    <div className="p-3 space-y-2">
      {error && <div className="text-xs text-status-danger">{error}</div>}
      {!result && !error && <div className="text-xs text-app-text-dim">Pick a base setup and click Recommend. Applying writes the suggestion to a new setup file you name.</div>}
      {result && (
        <div className="space-y-2">
          <div className="text-xs text-app-text-dim">Model: {result.model}</div>
          <DetectedFindings symptoms={result.symptoms} />
          {result.hasSetup === false ? (
            <>
              <div className="text-xs text-status-warning">No base setup selected — directional recommendation only. Pick a setup above to apply exact changes.</div>
              {result.intents.length === 0 ? (
                <div className="text-xs text-app-text-dim">No changes recommended.</div>
              ) : (
                <ul className="space-y-1">
                  {result.intents.map((it, i) => (
                    <li key={`${it.component}-${i}`} className="text-xs text-app-text">
                      <span className="font-mono text-(--focus-setup)">{it.component}</span>: {it.direction} ({it.magnitude}) <span className="text-app-text-dim">({it.reason})</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : result.applied.length === 0 ? (
            <div className="text-xs text-app-text-dim">No changes recommended.</div>
          ) : (
            <ul className="space-y-1">
              {result.applied.map((a, i) => (
                <li key={`${a.component}-${i}`} className="text-xs text-app-text">
                  <span className="font-mono text-(--focus-setup)">{a.component}</span>: {a.from} → {a.to} <span className="text-app-text-dim">({a.reason})</span>
                </li>
              ))}
            </ul>
          )}
          {/* LLM-free deterministic second opinion, shown alongside the model's
              picks when the LLM engine ran. */}
          {result.rulesIntents && result.rulesIntents.length > 0 && (
            <div className="border-t border-app-border pt-2 space-y-1">
              <div className="text-app-compact text-app-text-muted uppercase tracking-wider">Deterministic (LLM-free) recommendation</div>
              <ul className="space-y-1">
                {result.rulesIntents.map((it, i) => (
                  <li key={`rules-${it.component}-${i}`} className="text-xs text-app-text">
                    <span className="font-mono text-(--focus-driver)">{it.component}</span>: {it.direction} ({it.magnitude}) <span className="text-app-text-dim">({it.reason})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.skipped.length > 0 && (
            <ul className="space-y-1">
              {result.skipped.map((s, i) => (
                <li key={`${s.component}-${i}`} className="text-xs text-status-warning">
                  Skipped {s.component}: {s.reason}
                </li>
              ))}
            </ul>
          )}

          {/* Save-as: write the applied setup to a new, user-named file. */}
          {canApply && (
            <div className="border-t border-app-border pt-2 space-y-1.5">
              <div className="text-app-compact text-app-text-muted uppercase tracking-wider">Save as new setup</div>
              <div className="flex items-center gap-1.5">
                <input
                  value={saveAs}
                  onChange={(e) => setSaveAs(e.target.value)}
                  placeholder="setup name"
                  className="flex-1 min-w-0 bg-app-surface-alt border border-app-border rounded px-2 py-1 text-xs font-mono"
                />
                <span className="text-xs text-app-text-dim">.json</span>
                <Button type="button" variant="app-primary" size="app-sm" onClick={() => applyToFile(saveAs.trim() || undefined)} disabled={isPending || !saveAs.trim()} className="!h-auto bg-status-success hover:bg-status-success-hover">
                  {isPending ? "Saving…" : "Apply"}
                </Button>
              </div>
              <div className="text-app-compact text-app-text-dim">Creates a new file next to the base setup — the original is untouched.</div>
            </div>
          )}

          {result.written && (
            <div className="border-t border-app-border pt-2 text-xs text-status-success">
              Saved <span className="font-mono">{result.written.path.split(/[\\/]/).pop()}</span>. Load it in-game from the setup menu.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Suggest a setup filename from the selected base setup's name. */
function suggestName(filePath: string): string {
  const base =
    filePath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.json$/i, "") ?? "";
  return base ? `${base}-SE` : "setup-engineer";
}

interface Finding {
  text: string;
  severity: "critical" | "warn" | "info";
}

const FINDING_CLASS: Record<Finding["severity"], string> = {
  critical: "text-status-danger",
  warn: "text-status-warning",
  info: "text-status-info",
};

/**
 * Deterministic findings straight from the symptom report — shown regardless of
 * what the AI returns, so a weak/empty model response never hides real physics.
 */
function DetectedFindings({ symptoms }: { symptoms: any }) {
  const findings = deriveFindings(symptoms);
  return (
    <div className="space-y-1">
      <div className="text-app-compact text-app-text-muted uppercase tracking-wider">Detected from telemetry</div>
      {findings.length === 0 ? (
        <div className="text-xs text-app-text-dim">No handling or tyre issues detected in this lap.</div>
      ) : (
        <ul className="space-y-0.5">
          {findings.map((f) => (
            <li key={f.text} className={`text-xs ${FINDING_CLASS[f.severity]}`}>
              {f.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Project the deterministic symptom aggregate into a readable findings list.
 *  Pressure sign convention matches the server: +delta = above target → lower. */
function deriveFindings(symptoms: any): Finding[] {
  const agg = symptoms?.aggregate;
  if (!agg) return [];
  const out: Finding[] = [];

  const tp = agg.tyrePressure as Record<string, number> | null;
  if (tp) {
    for (const corner of ["FL", "FR", "RL", "RR"]) {
      const delta = tp[corner];
      if (typeof delta === "number" && Math.abs(delta) >= 1.0) {
        const dir = delta > 0 ? "lower" : "raise";
        out.push({
          text: `${corner} tyre pressure ${delta > 0 ? "+" : ""}${delta.toFixed(1)} psi vs target — ${dir} it`,
          severity: Math.abs(delta) >= 3 ? "critical" : "warn",
        });
      }
    }
  }
  if (agg.understeerCorners?.length) out.push({ text: `Understeer at ${agg.understeerCorners.join(", ")}`, severity: "warn" });
  if (agg.oversteerCorners?.length) out.push({ text: `Oversteer at ${agg.oversteerCorners.join(", ")}`, severity: "warn" });
  if (agg.lockupCorners?.length) out.push({ text: `Brake lockup at ${agg.lockupCorners.join(", ")}`, severity: "warn" });
  if (agg.bottomingCorners?.length) out.push({ text: `Suspension bottoming at ${agg.bottomingCorners.join(", ")}`, severity: "warn" });
  return out;
}
