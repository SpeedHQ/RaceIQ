/**
 * tireTempSymptoms — deterministic tire-temperature diagnosis for the auto-tune
 * pipeline (feature #3).
 *
 * The 3-point lateral temp profile (inner / middle / outer) plus core temp is
 * the richest physics-derived evidence we have for two setup axes the pressure
 * delta alone can't separate:
 *
 *   - **Camber** — from the inner-vs-outer spread. An inner edge running hotter
 *     than the outer means the contact patch is biased inboard under load, i.e.
 *     too much negative camber; the reverse means not enough.
 *   - **Pressure** — from the crown (middle) vs the shoulder mean. An
 *     overinflated tyre balloons and carries load on its crown, so the middle
 *     band runs hotter than the shoulders; underinflation is the reverse. This
 *     corroborates {@link tyrePressureDeltas} from an independent channel.
 *
 * Like tune-symptoms.ts this holds no setup knowledge — only observations. The
 * tune-intent LLM turns "inner 12 °C hotter than outer on FL" into a camber
 * click. Everything is averaged over loaded, on-track frames of the stint so a
 * single out-lap or spin can't skew a corner.
 *
 * ACC / AC-EVO only: the temp channels come from the acc-family parsers. When
 * they're absent (older games / legacy laps) {@link tireTempSymptoms} returns
 * null and callers simply omit tyre-temp context.
 */
import type { TelemetryPacket } from "../../shared/types";

export type TireCorner = "FL" | "FR" | "RL" | "RR";
type CamberBias = "excess_negative" | "insufficient_negative" | "balanced";
type PressureBias = "over" | "under" | "balanced";
type ThermalState = "cold" | "optimal" | "hot";

interface TireCornerTemp {
  corner: TireCorner;
  /** Mean core (carcass) temp over loaded frames, °C. */
  coreTempC: number;
  /** inner − outer surface temp, °C. +ve = inner edge hotter. */
  innerVsOuterC: number;
  /** middle − mean(inner, outer) surface temp, °C. +ve = crown hotter. */
  crownVsShoulderC: number;
  /** Camber read from the inner/outer spread; null when spread is within noise. */
  camberBias: CamberBias;
  /** Pressure read from the crown/shoulder spread; null when the middle band
   *  is unavailable (older parser without offsets 384-396). */
  pressureBias: PressureBias | null;
  /** Core temp vs the optimal window. */
  thermal: ThermalState;
}

interface TireTempSymptoms {
  corners: TireCornerTemp[];
  /** Mean core temp front axle − rear axle, °C. +ve = fronts hotter. */
  frontMinusRearC: number;
  /** Mean core temp left side − right side, °C. +ve = left hotter. */
  leftMinusRightC: number;
  /** Corner label of the hottest tyre by core temp, for quick reference. */
  hottestCorner: TireCorner;
}

// Inner/outer spread (°C) beyond which camber is called rather than "balanced".
// Below this the difference is within sensor + stint-variance noise.
const CAMBER_SPREAD_C = 5;
// Crown-vs-shoulder spread (°C) beyond which pressure bias is called.
const PRESSURE_SPREAD_C = 4;
// Optimal core-temp window (°C). Coarse, compound-agnostic slick heuristic —
// GT3/GTE dry slicks live roughly here; used only for a cold/hot flag, never a
// numeric target. Tighten per-compound later if a lookup lands.
const CORE_TEMP_COLD_C = 65;
const CORE_TEMP_HOT_C = 100;

// Minimum loaded frames before a corner's temps are trusted.
const MIN_FRAMES = 30;

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function camberBias(innerVsOuterC: number): CamberBias {
  if (innerVsOuterC > CAMBER_SPREAD_C) return "excess_negative";
  if (innerVsOuterC < -CAMBER_SPREAD_C) return "insufficient_negative";
  return "balanced";
}

function pressureBias(crownVsShoulderC: number | null): PressureBias | null {
  if (crownVsShoulderC == null) return null;
  if (crownVsShoulderC > PRESSURE_SPREAD_C) return "over";
  if (crownVsShoulderC < -PRESSURE_SPREAD_C) return "under";
  return "balanced";
}

function thermalState(coreTempC: number): ThermalState {
  if (coreTempC < CORE_TEMP_COLD_C) return "cold";
  if (coreTempC > CORE_TEMP_HOT_C) return "hot";
  return "optimal";
}

/**
 * Reduce a stint to a per-tyre thermal symptom report, or null when the temp
 * channels aren't present. Frames are filtered to on-track laps under load:
 * pit/stationary frames carry no lateral-profile signal and cold-tyre out-laps
 * would drag the means down.
 */
export function tireTempSymptoms(packets: TelemetryPacket[]): TireTempSymptoms | null {
  // The inner/core arrays are the acc-family tyre-temp signal (on packet.acc);
  // gate on them.
  const loaded = packets.filter(
    (p) => p.acc?.tireInnerTemp != null && p.acc?.tireCoreTemp != null && (p.Speed ?? 0) > 5,
  );
  if (loaded.length < MIN_FRAMES) return null;

  // tireMiddleTemp is a newer offset (384-396); it may be absent on laps parsed
  // before it was recovered. Only offer a pressure read when it's present.
  const hasMiddle = loaded.some((p) => p.acc?.tireMiddleTemp != null);

  const order: TireCorner[] = ["FL", "FR", "RL", "RR"];
  const corners: TireCornerTemp[] = order.map((corner, i) => {
    const core = mean(loaded.map((p) => p.acc!.tireCoreTemp[i]));
    const inner = mean(loaded.map((p) => p.acc!.tireInnerTemp[i]));
    const outer = mean(loaded.map((p) => p.acc!.tireOuterTemp[i]));
    const innerVsOuterC = inner - outer;
    const crownVsShoulderC = hasMiddle
      ? mean(loaded.filter((p) => p.acc?.tireMiddleTemp != null).map((p) => p.acc!.tireMiddleTemp![i])) -
        (inner + outer) / 2
      : null;
    return {
      corner,
      coreTempC: core,
      innerVsOuterC,
      crownVsShoulderC: crownVsShoulderC ?? 0,
      camberBias: camberBias(innerVsOuterC),
      pressureBias: pressureBias(crownVsShoulderC),
      thermal: thermalState(core),
    };
  });

  const coreOf = (c: TireCorner) => corners.find((x) => x.corner === c)!.coreTempC;
  const frontMinusRearC = (coreOf("FL") + coreOf("FR")) / 2 - (coreOf("RL") + coreOf("RR")) / 2;
  const leftMinusRightC = (coreOf("FL") + coreOf("RL")) / 2 - (coreOf("FR") + coreOf("RR")) / 2;
  const hottestCorner = corners.reduce((a, b) => (b.coreTempC > a.coreTempC ? b : a)).corner;

  return { corners, frontMinusRearC, leftMinusRightC, hottestCorner };
}

/**
 * Render a tyre-temp report as prompt prose. Shared by the tune-intent and
 * setup-engineer/tune-chat symptom formatters so both surface the same
 * evidence. `null` (channels absent) collapses to a single unavailable line.
 */
export function formatTireTempSymptoms(t: TireTempSymptoms | null): string {
  if (!t) return "Tyre temp data unavailable for this game.";
  const camberWord: Record<CamberBias, string> = {
    excess_negative: "inner hot (excess neg camber)",
    insufficient_negative: "outer hot (needs more neg camber)",
    balanced: "even",
  };
  const pressureWord: Record<PressureBias, string> = {
    over: "crown hot (over-pressure)",
    under: "shoulders hot (under-pressure)",
    balanced: "even",
  };
  const lines = t.corners
    .map((c) => {
      const parts = [
        `core ${c.coreTempC.toFixed(0)}°C (${c.thermal})`,
        `camber: ${camberWord[c.camberBias]} (Δi/o ${c.innerVsOuterC.toFixed(1)}°C)`,
        c.pressureBias
          ? `pressure: ${pressureWord[c.pressureBias]} (Δcrown ${c.crownVsShoulderC.toFixed(1)}°C)`
          : null,
      ].filter(Boolean);
      return `  ${c.corner} — ${parts.join(", ")}`;
    })
    .join("\n");
  return `Tyre temps (hottest ${t.hottestCorner}; front−rear ${t.frontMinusRearC.toFixed(1)}°C, left−right ${t.leftMinusRightC.toFixed(1)}°C):
${lines}`;
}
