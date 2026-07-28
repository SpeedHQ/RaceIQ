/**
 * Presentational half of the driver profile.
 *
 * Split from `DriverProfilePage` (which owns the scope, the fetch and the NDJSON
 * stream) so the layout can be rendered from fixed props — in Storybook, and in
 * tests. The states that matter most here are the awkward ones: a fingerprint
 * with no plan yet, axes that came back null, faults with no measured cost. Those
 * are exactly the states a live fetch makes hard to reach on demand.
 *
 * Two halves with different provenance, kept visually apart on purpose. The left
 * column is measured — it comes from the deterministic aggregator and is true
 * whether or not anyone ever calls a model. The right column is written by the
 * Driving Coach agent from those measurements. Presented as one continuous
 * document, model prose would borrow the authority of the telemetry.
 */
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { DriverFingerprint, RankedWeakness } from "../../../../server/ai/driver-profile-aggregate";
import type { DriverProfileOutput } from "../../../../server/ai/schemas";
import { StyleGauges } from "./StyleGauges";

export interface DriverProfileViewProps {
  fingerprint: DriverFingerprint;
  /** Null when only the deterministic half has been built. */
  plan: DriverProfileOutput | null;
  cached?: boolean;
  warnings?: string[];
}

/**
 * The ranking already answered "what should I do first", so only the top item
 * opens. Showing every card expanded puts five equally-weighted walls of text on
 * screen and quietly undoes that ordering.
 */
function FocusArea({ area, rank, detector, defaultOpen }: { area: DriverProfileOutput["focusAreas"][number]; rank: number; detector: RankedWeakness | undefined; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg bg-app-surface ring-1 ring-white/10">
        <CollapsibleTrigger className="flex w-full items-start gap-3 p-3 text-left">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold tabular-nums text-app-text">{rank}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-app-text">{area.title}</span>
            <span className="mt-0.5 block text-xs text-app-text-muted">{detector ? `Seen on ${(detector.perLapFrequency * 100).toFixed(0)}% of laps` : "From your profile"}</span>
          </span>
          {/* Absent means the aggregator could not defend a number — deliberately
              blank rather than "0.00 s", which would read as "costs nothing". */}
          {area.estimatedGainS !== undefined && (
            <span className="shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium tabular-nums text-green-400">~{area.estimatedGainS.toFixed(2)}s</span>
          )}
          <ChevronDown className={`mt-0.5 size-4 shrink-0 text-app-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-3 border-t border-white/5 px-3 pb-3 pt-3 text-sm">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-app-text-muted">What happens</p>
              <p className="mt-1 text-app-text">{area.whatHappens}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-app-text-muted">Why it costs</p>
              <p className="mt-1 text-app-text">{area.whyItCosts}</p>
            </div>
            <div className="rounded-md bg-blue-500/10 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-blue-400">Drill</p>
              <p className="mt-1 text-app-text">{area.drill}</p>
            </div>
            {detector && (
              <p className="text-xs text-app-text-muted">
                Measured: {detector.label} · {detector.lapsAffected} lap{detector.lapsAffected === 1 ? "" : "s"} · peak severity {detector.peakSeverity}
                {detector.medianTimeLossS === null && " · cost not measured"}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function DriverProfileView({ fingerprint: fp, plan, cached = false, warnings }: DriverProfileViewProps) {
  const detectorById = useMemo(() => {
    const map = new Map<string, RankedWeakness>();
    for (const w of [...fp.weaknesses, ...fp.unquantifiedWeaknesses]) map.set(w.id, w);
    return map;
  }, [fp]);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* ── Measured ───────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-app-text">Driving style</h2>
            <span className="text-xs text-app-text-muted">
              {fp.laps.analyzed} lap{fp.laps.analyzed === 1 ? "" : "s"} · {fp.confidence} confidence
            </span>
          </div>
          <p className="mb-2 text-xs text-app-text-muted">Measured from telemetry — these hold whether or not you run the coach.</p>
          {fp.style ? <StyleGauges style={fp.style} /> : <p className="py-4 text-sm text-app-text-muted">Not enough laps to characterise a style yet. Drive a few more and rebuild.</p>}
        </div>

        {fp.strengths.length > 0 && (
          <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
            <h2 className="mb-1 text-sm font-semibold text-app-text">Faults you don't have</h2>
            <p className="mb-2 text-xs text-app-text-muted">Things the analyser looks for and never found. Never detected is weaker than proven — but it's still a good sign.</p>
            <ul className="space-y-1.5">
              {fp.strengths.map((s) => (
                <li key={s.id} className="flex items-baseline gap-2 text-sm text-app-text">
                  <span className="text-green-400">✓</span>
                  <span>
                    {s.label}
                    <span className="ml-1 text-xs text-app-text-muted">{s.basis === "absent" ? "never fired" : `only ${(s.perLapFrequency * 100).toFixed(0)}% of laps, info only`}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recurring faults the aggregator could not cost. They get their own
            block rather than a "0.00s" row in the ranked list: unmeasured is
            not free, and a zero would read as "ignore this one". */}
        {fp.unquantifiedWeaknesses.length > 0 && (
          <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
            <h2 className="mb-1 text-sm font-semibold text-app-text">Recurring, cost not measured</h2>
            <p className="mb-2 text-xs text-app-text-muted">
              These happen often enough to matter, but the analyser can't put a defensible number on what they cost — usually because a fault above already counts it.
            </p>
            <ul className="space-y-1.5">
              {fp.unquantifiedWeaknesses.slice(0, 5).map((w) => (
                <li key={w.id} className="text-sm text-app-text">
                  {w.label}
                  <span className="ml-1 text-xs text-app-text-muted">
                    {(w.perLapFrequency * 100).toFixed(0)}% of laps · peak {w.peakSeverity}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {fp.notes.length > 0 && (
          <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
            <h2 className="mb-2 text-sm font-semibold text-app-text">Data caveats</h2>
            <ul className="space-y-1 text-xs text-app-text-muted">
              {fp.notes.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ── Coached ────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        {plan ? (
          <>
            <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-app-text">{plan.styleLabel}</h2>
                {cached && <span className="text-xs text-app-text-muted">cached</span>}
              </div>
              <p className="text-sm text-app-text">{plan.summary}</p>
            </div>

            <div>
              <h2 className="mb-2 text-sm font-semibold text-app-text">
                Work on this, in order
                <span className="ml-2 text-xs font-normal text-app-text-muted">most to gain first</span>
              </h2>
              <div className="space-y-2">
                {plan.focusAreas.map((area, i) => (
                  <FocusArea key={area.detectorId} area={area} rank={i + 1} detector={detectorById.get(area.detectorId)} defaultOpen={i === 0} />
                ))}
              </div>
              {/* The per-fault seconds are within-window estimates over
                  overlapping windows, so a total would be double-counted
                  fiction. Say so where someone would be tempted to add up. */}
              {plan.focusAreas.some((a) => a.estimatedGainS !== undefined) && (
                <p className="mt-2 text-[11px] text-app-text-muted/70">Time estimates are conservative and measured separately for each fault. They overlap, so don't add them up.</p>
              )}
            </div>

            {plan.sessionPlan.length > 0 && (
              <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
                <h2 className="mb-2 text-sm font-semibold text-app-text">Next session</h2>
                <ol className="space-y-1.5">
                  {plan.sessionPlan.map((step, i) => (
                    <li key={step} className="flex gap-2 text-sm text-app-text">
                      <span className="text-app-text-muted tabular-nums">{i + 1}.</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {plan.strengths.length > 0 && (
              <div className="rounded-lg bg-app-surface p-4 ring-1 ring-white/10">
                <h2 className="mb-2 text-sm font-semibold text-app-text">What's working</h2>
                <ul className="space-y-2">
                  {plan.strengths.map((s) => (
                    <li key={s.title} className="text-sm">
                      <span className="font-medium text-app-text">{s.title}</span>
                      <span className="block text-xs text-app-text-muted">{s.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {warnings?.map((w) => (
              <p key={w} className="text-xs text-amber-400/80">
                {w}
              </p>
            ))}
          </>
        ) : (
          <div className="rounded-lg bg-app-surface p-6 text-center ring-1 ring-white/10">
            <p className="text-sm text-app-text-muted">The measurements on the left are ready. Run the coach to turn them into a ranked plan.</p>
          </div>
        )}
      </section>
    </div>
  );
}
