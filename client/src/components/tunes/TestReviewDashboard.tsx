import type { LapMeta, TuneIssue } from "@shared/types";
import { useMemo, useState } from "react";
import { type TuningLapMetric, useLapIssues, useLapTelemetry, useSetLapExcluded } from "../../hooks/queries";
import { formatLapTime } from "../../lib/format";
import { isPitCycleLap } from "../../lib/lap-filters";
import { SectorDetailView } from "./SectorDetailView";

interface TestReviewDashboardProps {
  gameId: "acc" | "ac-evo";
  laps: LapMeta[];
  metricsById?: Map<number, TuningLapMetric>;
  /** Session to invalidate after toggling exclusion (design §Phase 7). */
  tuningSessionId?: number | null;
}

/**
 * TestReviewDashboard — shown after "End Test": a real tab bar (Overview +
 * one tab per recorded lap) over just the laps captured during this test run.
 * Per-lap tabs reuse SectorDetailView exactly as TuneReviewDashboard.tsx
 * composes it for a single lap (sector map + hover-synced corner bars).
 */
export function TestReviewDashboard({ gameId: _gameId, laps, metricsById, tuningSessionId }: TestReviewDashboardProps) {
  // Outlaps/inlaps/pit laps carry no tuning signal — drop them outright
  // (no tab, no list row, no aggregate contribution).
  const sortedLaps = useMemo(() => laps.filter((l) => !isPitCycleLap(l)).sort((a, b) => a.lapNumber - b.lapNumber), [laps]);
  const [tab, setTab] = useState<"overview" | number>("overview");

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-app-border overflow-x-auto">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </TabButton>
        {sortedLaps.map((l) => (
          <TabButton key={l.id} active={tab === l.id} onClick={() => setTab(l.id)}>
            Lap {l.lapNumber}
          </TabButton>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "overview" ? <OverviewTab laps={sortedLaps} metricsById={metricsById} tuningSessionId={tuningSessionId} /> : <LapTab lap={sortedLaps.find((l) => l.id === tab) ?? null} />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 text-xs rounded border shrink-0 ${active ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"}`}
    >
      {children}
    </button>
  );
}

function OverviewTab({ laps, metricsById, tuningSessionId }: { laps: LapMeta[]; metricsById?: Map<number, TuningLapMetric>; tuningSessionId?: number | null }) {
  const validLaps = useMemo(() => laps.filter((l) => l.isValid && l.lapTime > 0), [laps]);
  const lapCount = laps.length;
  const bestLap = validLaps.length ? Math.min(...validLaps.map((l) => l.lapTime)) : null;
  const worstLap = validLaps.length ? Math.max(...validLaps.map((l) => l.lapTime)) : null;
  const avgLap = validLaps.length ? validLaps.reduce((s, l) => s + l.lapTime, 0) / validLaps.length : null;

  const fuelVals = laps.map((l) => metricsById?.get(l.id)?.fuelPerLap).filter((v): v is number => v != null);
  const avgFuel = fuelVals.length ? fuelVals.reduce((s, v) => s + v, 0) / fuelVals.length : null;
  const wearVals = laps.map((l) => metricsById?.get(l.id)?.tyreWear).filter((v): v is number => v != null);
  const avgWorstWear = wearVals.length ? wearVals.reduce((s, v) => s + v, 0) / wearVals.length : null;

  const setExcluded = useSetLapExcluded();

  return (
    <div className="p-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <StatCard label="Laps" value={String(lapCount)} />
        <StatCard label="Best lap" value={bestLap != null ? formatLapTime(bestLap) : "—"} />
        <StatCard label="Avg lap" value={avgLap != null ? formatLapTime(avgLap) : "—"} />
        <StatCard label="Worst lap" value={worstLap != null ? formatLapTime(worstLap) : "—"} />
        <StatCard label="Fuel/lap" value={avgFuel != null ? `${avgFuel.toFixed(2)}L` : "—"} />
        <StatCard label="Worst wear" value={avgWorstWear != null ? `${avgWorstWear.toFixed(0)}%` : "—"} />
      </div>
      {lapCount === 0 ? (
        <div className="text-xs text-app-text-dim mt-3">No laps were recorded during this test.</div>
      ) : (
        <ul className="mt-3 divide-y divide-app-border/30 border border-app-border/40 rounded-md overflow-hidden">
          {laps.map((l) => {
            const excluded = l.tuningExcluded === true;
            return (
              <li key={l.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className={`font-mono ${excluded ? "line-through decoration-app-text-dim/60 opacity-60" : "text-app-text/90"}`}>Lap {l.lapNumber}</span>
                <span className={`font-mono tabular-nums text-app-text-dim ${excluded ? "line-through decoration-app-text-dim/60 opacity-60" : ""}`}>{formatLapTime(l.lapTime)}</span>
                {excluded && <span className="text-[10px] uppercase tracking-wider text-app-text-dim border border-app-border rounded px-1 py-0.5">Excluded</span>}
                <button
                  type="button"
                  onClick={() => setExcluded.mutate({ lapId: l.id, excluded: !excluded, tuningSessionId })}
                  disabled={setExcluded.isPending}
                  title={excluded ? "Include this lap in the tuning aggregate again" : "Exclude this lap from the tuning aggregate (blunder, off-track, spin)"}
                  className={`ml-auto text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border disabled:opacity-50 disabled:pointer-events-none ${
                    excluded ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"
                  }`}
                >
                  {excluded ? "Include" : "Exclude"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-app-surface-alt/30 rounded-lg p-3">
      <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className="text-xl font-mono font-black tabular-nums leading-none text-app-text/90">{value}</div>
    </div>
  );
}

function LapTab({ lap }: { lap: LapMeta | null }) {
  const { data: lapTel } = useLapTelemetry(lap?.id ?? null);
  const { data: issues } = useLapIssues(lap?.id ?? null);
  const [sectorIndex, setSectorIndex] = useState(0);

  if (!lap) return <div className="p-4 text-xs text-app-text-dim">Lap not found.</div>;

  const telemetry = lapTel?.telemetry ?? [];
  const sectorTimes = lapTel?.sectorTimes ?? null;

  const bySector = useMemo(() => {
    const groups: TuneIssue[][] = [[], [], []];
    const len = telemetry.length;
    const s1f = sectorTimes && len > 1 ? sectorTimes.s1Idx / (len - 1) : 1 / 3;
    const s2f = sectorTimes && len > 1 ? sectorTimes.s2Idx / (len - 1) : 2 / 3;
    for (const it of issues ?? []) {
      if (it.distanceFrac == null) continue;
      const s = it.distanceFrac < s1f ? 0 : it.distanceFrac < s2f ? 1 : 2;
      groups[s].push(it);
    }
    return groups;
  }, [issues, telemetry.length, sectorTimes]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-app-border">
        <span className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">
          Lap {lap.lapNumber} · {formatLapTime(lap.lapTime)}
        </span>
        <div className="flex gap-1 ml-auto">
          {[0, 1, 2].map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSectorIndex(i)}
              className={`px-2.5 py-1 text-xs rounded border ${sectorIndex === i ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"}`}
            >
              Sector {i + 1}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SectorDetailView telemetry={telemetry} sectorTimes={sectorTimes} sectorIndex={sectorIndex} trackOrdinal={lap.trackOrdinal} issues={bySector[sectorIndex]} />
      </div>
    </div>
  );
}
