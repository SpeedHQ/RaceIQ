import { useEffect, useMemo, useRef, useState } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import { decodeAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/codec";
import type { CoachingFamily } from "../contracts/coaching";
import { useSessionAnalyseHost } from "./host";
import { useThreeToImprove, useThreeToImproveEvidence } from "./queries";

const familyCopy: Record<CoachingFamily, { title: "coaching_family_brake_drag" | "coaching_family_downshift" | "coaching_family_throttle" | "coaching_family_steering" | "coaching_family_front_scrub"; pattern: "coaching_pattern_brake_drag" | "coaching_pattern_downshift" | "coaching_pattern_throttle" | "coaching_pattern_steering" | "coaching_pattern_front_scrub"; action: "coaching_action_brake_drag" | "coaching_action_downshift" | "coaching_action_throttle" | "coaching_action_steering" | "coaching_action_front_scrub" }> = {
  "brake-drag": { title: "coaching_family_brake_drag", pattern: "coaching_pattern_brake_drag", action: "coaching_action_brake_drag" },
  downshift: { title: "coaching_family_downshift", pattern: "coaching_pattern_downshift", action: "coaching_action_downshift" },
  throttle: { title: "coaching_family_throttle", pattern: "coaching_pattern_throttle", action: "coaching_action_throttle" },
  steering: { title: "coaching_family_steering", pattern: "coaching_pattern_steering", action: "coaching_action_steering" },
  "front-scrub": { title: "coaching_family_front_scrub", pattern: "coaching_pattern_front_scrub", action: "coaching_action_front_scrub" },
};

export function ThreeToImprove({ gameId, sessionId }: { gameId: GameId; sessionId: number }) {
  const { m, Button, CoachingEvidenceChart } = useSessionAnalyseHost();
  const summary = useThreeToImprove(sessionId);
  const [selected, setSelected] = useState<{ lapId: number; sourceFrameIndex: number; fraction: number; family: CoachingFamily; lapNumber: number; cornerName: string | null; supportingLapCount: number } | null>(null);
  const evidence = useThreeToImproveEvidence(selected && { sessionId, lapId: selected.lapId, sourceFrameIndex: selected.sourceFrameIndex });
  const selectedStillPresent = selected != null && !summary.isError && summary.data?.items.some((item) => item.representative.lapId === selected.lapId && item.representative.sourceFrameIndex === selected.sourceFrameIndex);
  const activeEvidenceButton = useRef<HTMLButtonElement | null>(null);
  const scope = useRef({ gameId, sessionId });
  useEffect(() => {
    if (scope.current.gameId !== gameId || scope.current.sessionId !== sessionId) {
      scope.current = { gameId, sessionId };
      setSelected(null);
    }
  }, [gameId, sessionId]);
  const closeButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (selected && !selectedStillPresent) setSelected(null);
  }, [selected, selectedStillPresent]);
  useEffect(() => {
    if (selected) closeButton.current?.focus();
  }, [selected]);
  const aligned = useMemo(() => evidence.data ? decodeAlignedLapSet(evidence.data.aligned) : null, [evidence.data]);
  const trace = aligned?.laps.find((lap) => lap.lapId === selected?.lapId);
  const processingFailure = (summary.error as { status?: number; message?: string } | null)?.status === 422;
  const blockedSummary = blocked(summary.error);
  function blocked(error: unknown) {
    const status = (error as { status?: number } | null)?.status;
    return status === 409 || status === 422;
  }
  return <section aria-label={m.coaching_title()} className="border-b border-app-border px-4 py-3" data-testid="three-to-improve">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-app-text">{m.coaching_title()}</h2>
        <p className="text-xs text-app-text-muted">{m.coaching_scope()}</p>
      </div>
      {summary.isError && <Button variant="app-outline" size="app-sm" onClick={() => void summary.refetch()}>{m.coaching_retry()}</Button>}
    </div>
    {summary.isFetching ? <p role="status" className="mt-2 text-xs text-app-text-muted">{m.coaching_loading()}</p>
      : summary.isError ? <p role={blockedSummary ? "status" : "alert"} className="mt-2 text-xs text-status-danger">{processingFailure ? m.recording_processing_failed({ error: (summary.error as { message?: string } | null)?.message ?? "" }) : blockedSummary ? m.recording_processing_running() : m.coaching_error()}</p>
        : summary.data?.state === "insufficient-data" ? <><p role="status" className="mt-2 text-xs text-app-text-muted">{m.coaching_insufficient()}</p><p className="mt-2 text-xs text-app-text-muted">{m.coaching_count_summary({ analyzed: summary.data.analyzedLapCount, eligible: summary.data.eligibleLapCount, unlocated: summary.data.unlocatedEvidenceCount })}</p></>
          : summary.data?.state === "no-actionable-findings" ? <><p role="status" className="mt-2 text-xs text-app-text-muted">{m.coaching_empty()}</p><p className="mt-2 text-xs text-app-text-muted">{m.coaching_count_summary({ analyzed: summary.data.analyzedLapCount, eligible: summary.data.eligibleLapCount, unlocated: summary.data.unlocatedEvidenceCount })}</p></>
            : <>
              <p className="mt-2 text-xs text-app-text-muted">{m.coaching_count_summary({ analyzed: summary.data?.analyzedLapCount ?? 0, eligible: summary.data?.eligibleLapCount ?? 0, unlocated: summary.data?.unlocatedEvidenceCount ?? 0 })}</p>
              <div className="mt-3 grid gap-2 @3xl/workspace:grid-cols-3">
                {summary.data?.items.map((item) => {
                  const copy = familyCopy[item.family];
                  const location = item.location.cornerName
                    ? m.coaching_location_corner({ corner: item.location.cornerName })
                    : m.coaching_location_percent({ percent: Math.round(item.location.fraction * 100) });
                  const pattern = m[copy.pattern]();
                  const action = m[copy.action]();
                  return <article key={item.id} className="min-w-0 rounded border border-app-border bg-app-bg p-3" data-coaching-family={item.family}>
                    <h3 className="text-sm font-semibold text-app-text">{m[copy.title]()} <span className="font-normal text-app-text-muted">— {location}</span></h3>
                    <p className="mt-1 text-xs text-app-text-secondary">{pattern}</p>
                    <p className="mt-2 text-xs text-app-text"><span className="font-semibold">{m.coaching_next_run()}:</span> {action}</p>
                    <p className="mt-2 text-xs text-app-text-muted">{item.evidenceLevel === "single-lap" ? m.coaching_single_lap() : m.coaching_repeated({ count: item.supportingLapCount })}</p>
                    <Button variant="app-outline" size="app-sm" className="mt-3" aria-label={`${m.coaching_evidence()} — ${m.coaching_lap({ lap: item.representative.lapNumber })}`} onClick={(event) => { activeEvidenceButton.current = event.currentTarget; setSelected({ ...item.representative, fraction: item.location.fraction, family: item.family, lapNumber: item.representative.lapNumber, cornerName: item.location.cornerName, supportingLapCount: item.supportingLapCount }); }}>{m.coaching_evidence()} · {m.coaching_lap({ lap: item.representative.lapNumber })}</Button>
                  </article>;
                })}
              </div>
            </>}
    {selected && <div role="region" aria-label={m.coaching_evidence()} className="mt-3 rounded border border-app-border p-3" data-testid="three-to-improve-evidence" onKeyDown={(event) => { if (event.key === "Escape") { setSelected(null); activeEvidenceButton.current?.focus(); } }}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-app-text">{m.coaching_lap({ lap: evidence.data?.representative.lapNumber ?? selected.lapNumber })}</h3>
        <Button ref={closeButton} variant="app-ghost" size="icon-sm" aria-label={m.coaching_evidence_close()} onClick={() => { setSelected(null); activeEvidenceButton.current?.focus(); }}>×</Button>
      </div>
      {evidence.isLoading ? <p role="status" className="py-3 text-xs text-app-text-muted">{m.coaching_loading()}</p>
        : evidence.isError ? <div role="alert" className="flex flex-wrap items-center gap-2 py-3 text-xs text-status-danger"><span>{(evidence.error as { code?: string } | null)?.code === "COACHING_EVIDENCE_CHANGED" ? m.coaching_evidence_changed() : m.coaching_error()}</span><Button variant="app-outline" size="app-sm" onClick={() => { setSelected(null); void summary.refetch(); }}>{m.coaching_retry()}</Button></div>
          : aligned && trace ? <>
            <p className="mb-2 text-xs text-app-text-secondary">{m[familyCopy[selected.family].title]()} — {selected.cornerName ? m.coaching_location_corner({ corner: selected.cornerName }) : m.coaching_location_percent({ percent: Math.round(selected.fraction * 100) })}</p>
            <p className="mb-3 text-xs text-app-text-secondary">{m[familyCopy[selected.family].action]()}</p>
            <div tabIndex={0} aria-label={m.coaching_evidence()} className="max-h-[min(55dvh,32rem)] overflow-y-auto overscroll-contain rounded border border-app-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-primary">
              <CoachingEvidenceChart trace={trace} markerFraction={evidence.data?.fraction ?? selected.fraction} />
            </div>
          </>
            : <p role="status" className="py-3 text-xs text-app-text-muted">{m.coaching_insufficient()}</p>}
    </div>}
  </section>;
}
