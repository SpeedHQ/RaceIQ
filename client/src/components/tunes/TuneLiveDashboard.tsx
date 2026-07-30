import { tryGetGame } from "@shared/games/registry";
import type { GameId, LapMeta, TuneIssue } from "@shared/types";
import { useEffect, useMemo, useState } from "react";
import { useLiveAnalysisToggle, useTirePressureOptimal } from "../../hooks/queries";
import { useTelemetryStore } from "../../stores/telemetry";
import { LiveTrackMap } from "../LiveTrackMap";
import { RaceInfo } from "../RaceInfo";
import { RecordedLaps } from "../RecordedLaps";
import { PitEstimate } from "../telemetry/PitEstimate";
import { TireGrid } from "../telemetry/TireGrid";
import { AutoTunePanel } from "./AutoTunePanel";

const SEVERITY_ORDER: Record<TuneIssue["severity"], number> = { critical: 0, warn: 1, info: 2 };
const SEVERITY_CLASS: Record<TuneIssue["severity"], string> = {
  critical: "text-status-danger border-status-danger/30 bg-status-danger/10",
  warn: "text-status-warning border-status-warning/30 bg-status-warning/10",
  info: "text-status-info border-status-info/30 bg-status-info/10",
};

/** How long a transient issue keeps showing after it stops being re-emitted
 *  in the live broadcast, before it's dropped from the alert strip. */
const TRANSIENT_TTL_MS = 2000;

interface TuneLiveDashboardProps {
  gameId: GameId;
  trackName?: string;
  sessionLaps: LapMeta[];
}

/**
 * TuneLiveDashboard — the "live practice cockpit" for the Tune tab (Phase 3/4).
 * Composes existing live-telemetry widgets (tire state, fuel/stint, delta/pace,
 * track map) with the auto-tune recommendation and a two-cadence issue feed:
 * transient alerts (this instant) and per-lap summaries (persisted feed pushed
 * over WS on lap completion). Rendered only while the dashboard is following
 * the live session — enables the server's live issue detector on mount and
 * disables it again on unmount so it costs nothing once the driver leaves.
 */
export function TuneLiveDashboard({ gameId, trackName, sessionLaps }: TuneLiveDashboardProps) {
  useLiveAnalysisToggle(true);

  const packet = useTelemetryStore((s) => s.packet);
  const sectors = useTelemetryStore((s) => s.sectors);
  const pit = useTelemetryStore((s) => s.pit);
  const liveIssues = useTelemetryStore((s) => s.liveIssues);
  const lapIssuesFeed = useTelemetryStore((s) => s.lapIssuesFeed);
  const pressureOptimal = useTirePressureOptimal(gameId, packet?.CarOrdinal);

  // Track each transient issue's last-seen time so the alert strip can expire
  // ones that stop being re-emitted, rather than blinking with every packet.
  const [seenAt, setSeenAt] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    const now = Date.now();
    setSeenAt((prev) => {
      const next = new Map(prev);
      for (const issue of liveIssues) next.set(issueKey(issue), now);
      return next;
    });
  }, [liveIssues]);

  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  const activeTransients = useMemo(() => {
    const now = Date.now();
    const byKey = new Map<string, TuneIssue>();
    for (const issue of liveIssues) byKey.set(issueKey(issue), issue);
    return [...seenAt.entries()]
      .filter(([, last]) => now - last < TRANSIENT_TTL_MS)
      .map(([key]) => byKey.get(key))
      .filter((i): i is TuneIssue => !!i)
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }, [seenAt, liveIssues]);

  if (!packet || packet.gameId !== gameId) {
    return <div className="p-3 text-xs text-app-text-dim">Waiting for live telemetry…</div>;
  }

  return (
    <div className="grid flex-1 grid-cols-1 gap-0 @5xl/workspace:grid-cols-2">
      {/* Left column: tires, fuel/stint, recommendation */}
      <div className="border-r border-app-border overflow-auto">
        <div className="border-b border-app-border">
          <TireGrid
            fl={{ tempC: packet.TireTempFL, wear: packet.TireWearFL, brakeTemp: packet.BrakeTempFrontLeft ?? 0, brakePadMm: packet.acc?.brakePadWear[0], pressure: packet.TirePressureFrontLeft ?? 0 }}
            fr={{
              tempC: packet.TireTempFR,
              wear: packet.TireWearFR,
              brakeTemp: packet.BrakeTempFrontRight ?? 0,
              brakePadMm: packet.acc?.brakePadWear[1],
              pressure: packet.TirePressureFrontRight ?? 0,
            }}
            rl={{ tempC: packet.TireTempRL, wear: packet.TireWearRL, brakeTemp: packet.BrakeTempRearLeft ?? 0, brakePadMm: packet.acc?.brakePadWear[2], pressure: packet.TirePressureRearLeft ?? 0 }}
            rr={{ tempC: packet.TireTempRR, wear: packet.TireWearRR, brakeTemp: packet.BrakeTempRearRight ?? 0, brakePadMm: packet.acc?.brakePadWear[3], pressure: packet.TirePressureRearRight ?? 0 }}
            healthThresholds={tryGetGame(gameId)?.tireHealthThresholds ?? { green: 0.85, yellow: 0.7 }}
            tempThresholds={{ blue: 70, orange: 100, red: 110 }}
            pressureOptimal={pressureOptimal}
            brakeTempThresholds={tryGetGame(gameId)?.brakeTempThresholds}
            compound={packet.acc?.tireCompound}
          />
        </div>

        <div className="border-b border-app-border p-3">
          <PitEstimate packet={packet} pit={pit} />
        </div>

        <AutoTunePanel gameId={gameId as "acc" | "ac-evo"} laps={sessionLaps} trackName={trackName} liveMode />
      </div>

      {/* Right column: race info + track map w/ issue markers, lap list, issue feed */}
      <div className="overflow-auto flex flex-col">
        <RaceInfo packet={packet} sectors={sectors} trackName={trackName} carName={undefined} showTrackMap={false} showSectors />

        <div style={{ minHeight: 220 }} className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <div className="text-xs font-semibold text-app-text-muted uppercase tracking-wider truncate">{trackName || "Track Map"}</div>
          </div>
          <LiveTrackMap packet={packet} issues={liveIssues} />
        </div>

        {/* Issue feed: transient alerts (top) + per-lap summaries (below) */}
        <div className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Issues</h2>
          </div>
          <div className="p-3 space-y-2">
            {activeTransients.length === 0 && lapIssuesFeed.length === 0 && <div className="text-xs text-app-text-dim">No issues detected — clean lap so far.</div>}
            {activeTransients.length > 0 && (
              <div className="space-y-1">
                {activeTransients.map((issue) => (
                  <div key={issueKey(issue)} className={`text-xs px-2 py-1 rounded border ${SEVERITY_CLASS[issue.severity]}`}>
                    <span className="font-mono uppercase mr-1">{issue.kind}</span>
                    {issue.detail}
                  </div>
                ))}
              </div>
            )}
            {lapIssuesFeed.length > 0 && (
              <div className="space-y-2">
                {lapIssuesFeed.slice(0, 5).map((entry) => (
                  <div key={entry.lapId} className="border border-app-border rounded p-2">
                    <div className="text-app-compact text-app-text-muted uppercase tracking-wider mb-1">Lap {entry.lapNumber}</div>
                    {entry.issues.length === 0 ? (
                      <div className="text-xs text-app-text-dim">No issues.</div>
                    ) : (
                      <ul className="space-y-1">
                        {entry.issues.map((issue) => (
                          <li key={issueKey(issue)} className={`text-xs px-1.5 py-0.5 rounded border ${SEVERITY_CLASS[issue.severity]}`}>
                            {issue.corner ? <span className="font-mono mr-1">{issue.corner}</span> : null}
                            {issue.detail}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <RecordedLaps laps={sessionLaps} />
        </div>
      </div>
    </div>
  );
}

function issueKey(issue: TuneIssue): string {
  return `${issue.kind}:${issue.corner ?? ""}`;
}
