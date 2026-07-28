/**
 * Prompt builder for the Driving Coach agent.
 *
 * The contract with the model is narrow on purpose: everything quantitative has
 * already been decided by `driver-profile-aggregate.ts`. This file's whole job
 * is to hand those results over in a form the model cannot misread.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *  1. **Every style axis is rendered as a plain-language reading first, then the
 *     number with its reference range.** A bare "0.72" invites the model to
 *     narrate it as a percentage or a score out of one. Rendering "You work the
 *     tyres in a normal quick-driver range. 0.72, where 1.0 = at peak grip"
 *     leaves nothing to infer. The readings come from fixed thresholds in
 *     `@shared/lib/style-readings` rather than from the model's judgement, so
 *     the same numbers always produce the same claim — and the profile panel
 *     renders those same functions, so screen and plan cannot disagree.
 *
 *  2. **An unquantified cost is stated as unquantified, never as zero.** The
 *     aggregator returns weaknesses in two lists precisely because their scores
 *     are not comparable (see `RankedWeakness`). Flattening them into one table
 *     with `0.00 s` in the empty cells would tell the model those faults are
 *     free, and it would dutifully deprioritise them. They get their own
 *     section with an explicit note instead.
 */
import {
  balanceReading,
  brakingStyleReading,
  consistencyReading,
  controlLossReading,
  gripMedianReading,
  gripP95Reading,
  reversalsReading,
  slipVariabilityReading,
} from "../../shared/lib/style-readings";
import type {
  DetectorStat,
  DriverFingerprint,
  PaceProfile,
  RankedWeakness,
  StyleAxes,
} from "./driver-profile-aggregate";

export interface CoachPromptContext {
  fingerprint: DriverFingerprint;
  /** Resolved display name for the scoped car, when the scope pins one. */
  carName?: string;
  /** Resolved display name for the scoped track, when the scope pins one. */
  trackName?: string;
  gameName: string;
  /** Settings language, e.g. "en". Passed through to the output-language line. */
  language?: string;
}

/** Cap on how many rows reach the prompt. Beyond this the tail is noise. */
const MAX_FOCUS_ROWS = 6;
const MAX_UNQUANTIFIED_ROWS = 5;
const MAX_STRENGTH_ROWS = 6;

function fmt(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "not measured" : n.toFixed(digits);
}

function pct(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "not measured" : `${(n * 100).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Style axes → words
// ---------------------------------------------------------------------------

/**
 * Each axis renders as `reading (number, with what the number is measured against)`.
 *
 * The wording comes from `@shared/lib/style-readings` — the same functions the
 * profile panel renders. Restating the thresholds here would let the prompt and
 * the UI describe an identical number two different ways, and the driver would
 * have no way to tell which one to believe.
 */
function describeStyle(style: StyleAxes): string[] {
  const lines: string[] = [];

  if (style.gripUtilMedian !== null) {
    lines.push(`- Grip usage (median): ${gripMedianReading(style.gripUtilMedian).text} ${fmt(style.gripUtilMedian)}, where 1.0 = at peak grip.`);
  }
  if (style.gripUtilP95 !== null) {
    lines.push(`- Grip usage (peak, 95th percentile): ${gripP95Reading(style.gripUtilP95).text} ${fmt(style.gripUtilP95)}, where 1.0 = at the limit.`);
  }
  if (style.balanceMedianDeg !== null) {
    const v = style.balanceMedianDeg;
    lines.push(
      `- Balance: ${balanceReading(v).text} ${v > 0 ? "+" : ""}${fmt(v, 1)}° front-minus-rear slip angle (positive = understeer). ±1-3° is a normal working range.`,
    );
  }
  if (style.understeerFraction !== null || style.oversteerFraction !== null) {
    lines.push(`- Cornering frames classified: ${pct(style.understeerFraction)} understeer, ${pct(style.oversteerFraction)} oversteer.`);
  }
  if (style.controlLossFraction !== null) {
    lines.push(
      `- Loss of control: ${controlLossReading(style.controlLossFraction).text} ${pct(style.controlLossFraction)} of cornering frames have the body rotating faster than the path demands with the rear carrying more slip than the front.`,
    );
  }
  if (style.steerReversalsPerS !== null) {
    lines.push(`- Steering variability: ${reversalsReading(style.steerReversalsPerS).text} ${fmt(style.steerReversalsPerS, 1)} direction reversals per second of cornering (0.5-2 /s is ordinary).`);
  }
  if (style.slipVariabilityDeg !== null) {
    lines.push(
      `- Attitude stability: ${slipVariabilityReading(style.slipVariabilityDeg).text} Slip delta moves ${fmt(style.slipVariabilityDeg, 1)}° about its median (0.5-1.5° is ordinary). This is blind to how much slip is carried; it measures only how much it moves.`,
    );
  }

  // Deliberately last and explicitly caveated: unlike the axes above it has no
  // absolute scale, so it must not be read alongside them as if it did.
  const bs = style.brakingStyle;
  lines.push(
    `- Braking timing lean: ${brakingStyleReading(bs).text} (${bs > 0 ? "+" : ""}${bs.toFixed(0)} on a -100 early … +100 late scale). RELATIVE ONLY — read the sign and the size, never as a percentage.`,
  );

  if (style.consistency !== null) {
    lines.push(`- Consistency: ${consistencyReading(style.consistency).text} ${style.consistency.toFixed(0)}/100 lap-time repeatability.`);
  }

  lines.push(`(Style measured across ${style.physicsLaps} laps with usable cornering telemetry.)`);
  return lines;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function focusRow(w: RankedWeakness): string {
  const freq = `${(w.perLapFrequency * 100).toFixed(0)}% of laps`;
  const cost =
    w.medianTimeLossS === null
      ? "cost not measured"
      : `~${w.medianTimeLossS.toFixed(2)} s/lap (median, measured on ${w.lapsQuantified} lap${w.lapsQuantified === 1 ? "" : "s"})`;
  return `- id: ${w.id} | ${w.label} | ${freq} | peak severity ${w.peakSeverity} | ${cost}\n    example: ${w.sampleDetail}`;
}

function paceBlock(pace: PaceProfile): string {
  const lines: string[] = [];
  lines.push(`- Laps in pool: ${pace.n} across ${pace.contexts} car+track combination${pace.contexts === 1 ? "" : "s"}.`);
  if (pace.consistency !== null) lines.push(`- Consistency: ${pace.consistency.toFixed(0)}/100.`);
  if (pace.basis === "single-context") {
    if (pace.bestS !== null) lines.push(`- Best lap: ${pace.bestS.toFixed(3)} s.`);
    if (pace.meanS !== null) lines.push(`- Mean lap: ${pace.meanS.toFixed(3)} s.`);
    if (pace.sdS !== null) lines.push(`- Lap-time spread: ${pace.sdS.toFixed(3)} s standard deviation.`);
    if (pace.degSlopeSPerLap !== null) {
      const s = pace.degSlopeSPerLap;
      lines.push(`- Trend: ${s >= 0 ? "+" : ""}${s.toFixed(3)} s per lap over the stint (${s > 0.02 ? "dropping off" : s < -0.02 ? "building pace" : "flat"}).`);
    }
  } else {
    // Seconds mean nothing once the pool spans tracks — averaging a Monza lap
    // with a Spa lap is arithmetic on incomparable quantities, so the
    // aggregator withholds them and the prompt must say why rather than
    // leaving the model to wonder where the lap times went.
    lines.push(
      `- Lap times are NOT reported: this pool spans multiple car/track combinations, so a best or mean lap time would be meaningless. Only the unitless numbers above carry over.`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildDrivingCoachPrompt(ctx: CoachPromptContext): string {
  const { fingerprint: fp } = ctx;
  const parts: string[] = [];

  const scopeBits = [ctx.gameName];
  if (ctx.carName) scopeBits.push(ctx.carName);
  if (ctx.trackName) scopeBits.push(ctx.trackName);
  parts.push(`# DRIVER PROFILE — ${scopeBits.join(" · ")}`);
  parts.push(
    fp.scope.kind === "global"
      ? `Scope: every lap this driver has recorded in ${ctx.gameName}, across cars and tracks.`
      : `Scope: this driver's laps in one specific car and track.`,
  );
  parts.push(
    `Built from ${fp.laps.analyzed} lap${fp.laps.analyzed === 1 ? "" : "s"} (of ${fp.laps.candidates} in scope). Confidence: ${fp.confidence}.`,
  );

  // ── Style ────────────────────────────────────────────────────────────────
  parts.push(`\n## DRIVING STYLE`);
  if (fp.style === null) {
    parts.push(
      `Not enough laps to characterise a style. Say so plainly in \`summary\`, keep \`styleLabel\` non-committal, and do not guess at a style from the fault list alone.`,
    );
  } else {
    parts.push(
      `These are physical measurements from the telemetry, not scores. Each line gives the plain-language reading first and the raw number second, with what the number is measured against. Use the plain-language reading when you write; quote a number only when it adds something.`,
    );
    parts.push(describeStyle(fp.style).join("\n"));
  }

  // ── Pace ─────────────────────────────────────────────────────────────────
  parts.push(`\n## PACE`);
  parts.push(paceBlock(fp.pace));

  // ── Focus areas ──────────────────────────────────────────────────────────
  parts.push(`\n## FOCUS AREAS (ranked, most time to gain first)`);
  if (fp.weaknesses.length === 0) {
    parts.push(`None of this driver's recurring faults could be costed in seconds. Build \`focusAreas\` from the section below instead.`);
  } else {
    parts.push(
      `Ranked by frequency x severity x measured cost. The seconds are conservative within-window estimates — real, but a floor rather than the whole story. NEVER add them together into a lap total: these faults overlap in time and the sum would be nonsense.`,
    );
    parts.push(fp.weaknesses.slice(0, MAX_FOCUS_ROWS).map(focusRow).join("\n"));
  }

  // ── Unquantified ─────────────────────────────────────────────────────────
  if (fp.unquantifiedWeaknesses.length > 0) {
    parts.push(`\n## RECURRING FAULTS WITH NO MEASURED COST`);
    parts.push(
      `These fire often enough to matter but the analyser cannot put a defensible number on what they cost — usually because they are a symptom whose cost is already counted by one of the faults above. "Not measured" does NOT mean "costs nothing", and it does NOT mean "less important". Rank them on frequency and severity, and omit \`estimatedGainS\` for any of them.`,
    );
    parts.push(fp.unquantifiedWeaknesses.slice(0, MAX_UNQUANTIFIED_ROWS).map(focusRow).join("\n"));
  }

  // ── Strengths ────────────────────────────────────────────────────────────
  if (fp.strengths.length > 0) {
    parts.push(`\n## STRENGTHS (faults this driver does NOT have)`);
    parts.push(
      `Each of these is a fault the analyser looks for and did not find. Turn them into genuine praise, but keep it honest — never absent means never detected, not proof of mastery.`,
    );
    parts.push(
      fp.strengths
        .slice(0, MAX_STRENGTH_ROWS)
        .map((s) => `- ${s.label} — ${s.basis === "absent" ? "never fired across the pool" : `fired on only ${(s.perLapFrequency * 100).toFixed(0)}% of laps, and only at 'info' severity`}`)
        .join("\n"),
    );
  }

  // ── Notes ────────────────────────────────────────────────────────────────
  if (fp.notes.length > 0) {
    parts.push(`\n## DATA CAVEATS`);
    parts.push(fp.notes.map((n) => `- ${n}`).join("\n"));
  }

  // ── Task ─────────────────────────────────────────────────────────────────
  parts.push(`\n## YOUR TASK`);
  parts.push(
    [
      `Write this driver's improvement plan.`,
      ``,
      `- Every \`focusAreas[].detectorId\` MUST be an id copied exactly from the tables above. Do not invent faults, and do not raise something the tables do not report.`,
      `- Keep the ranking you were given. It already accounts for how often each fault happens, how bad it is, and what it costs.`,
      `- Copy \`estimatedGainS\` verbatim from the row's measured cost. Omit the field entirely when the row says the cost was not measured — do not write 0, and do not estimate one yourself.`,
      `- Explain the *mechanism* in \`whyItCosts\`. "You brake too early, which costs 0.2 s" restates the table; "braking before the car is straight means you carry the deceleration into the corner and have to wait for the front to bite" explains it.`,
      `- Every \`drill\` needs something the driver can actually check — a reference point, a count, a feel they should notice — otherwise it is a slogan.`,
      `- Address the driver as "you".`,
      `- Output JSON only, matching the schema in your instructions. No prose outside it, no markdown fences.`,
    ].join("\n"),
  );

  if (ctx.language && ctx.language !== "en") {
    parts.push(`\nWrite all prose in language code "${ctx.language}".`);
  }

  return parts.join("\n");
}

/** Detector-id whitelist for validating model output against the fingerprint. */
export function allowedDetectorIds(detectors: DetectorStat[]): Set<string> {
  return new Set(detectors.map((d) => d.id));
}
