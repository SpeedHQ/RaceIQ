/**
 * consultLapAnalystForSession — let the Setup Engineer delegate deep, corner-by
 * corner lap analysis to the Lap Analyst agent.
 *
 * The Setup Engineer reasons about *setup*; the Lap Analyst reasons about
 * *driving and telemetry*. When the driver asks something that needs the latter
 * ("why am I slow in the last sector?"), the engineer calls this to get a real
 * analysis of the session's representative lap instead of guessing.
 *
 * Mirrors the invocation the `/api/laps/:id/analyse` route uses (corners,
 * track context, prompt, and the provider secret→env bridge for the Lap
 * Analyst's own `aiProvider`/`aiModel`, which are distinct from the chat
 * provider the engineer runs on).
 */
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import type { Corner } from "@raceiq/backend-core/lap-analysis/corners";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { configureAiProviderEnvironment } from "@raceiq/assistant/ai/openai-compatible-provider";
import { buildAnalystPrompt } from "@raceiq/assistant/ai/analyst-prompt";
import { getOrComputeLapInsights } from "@raceiq/backend-core/lap-analysis/metrics-store";

export interface LapAnalystConsult {
  available: boolean;
  summary: string;
}

export function createConsultLapAnalystForSession(deps: {
  resolveLapCorners: (track: string | null | undefined, game: string | null | undefined, telemetry: TelemetryPacket[], options: { segments: readonly NamedSegment[] }) => Promise<Corner[]>;
  resolveLapSegments: (track: string | null | undefined, game: string | null | undefined) => Promise<NamedSegment[]>;
  loadRepresentativeLap: (sessionId: number, opts?: { lapIds?: readonly number[] }) => Promise<(LapMeta & { telemetry: TelemetryPacket[] }) | null>;
  generate: (prompt: string, options: { maxSteps: number; activeTools?: never[]; modelSettings: { maxOutputTokens: number; temperature: number } }) => Promise<{ text?: string }>;
}) {
const { resolveLapCorners, resolveLapSegments, loadRepresentativeLap, generate } = deps;
return async function consultLapAnalystForSession(
  sessionId: number,
  opts?: { lapIds?: readonly number[] },
): Promise<LapAnalystConsult> {
  const lap = await loadRepresentativeLap(sessionId, opts);
  if (!lap) {
    return {
      available: false,
      summary: opts?.lapIds == null
        ? "No analysable lap yet for this session."
        : "No analysable lap yet in this experiment branch.",
    };
  }

  const trackIdentity = lap.trackId;
  const segments = await resolveLapSegments(trackIdentity, lap.gameId);
  const corners = await resolveLapCorners(trackIdentity, lap.gameId, lap.telemetry, { segments });

  const settings = loadSettings();
  const insights = await getOrComputeLapInsights(lap.id) ?? [];
  const prompt = buildAnalystPrompt(
    lap,
    lap.telemetry,
    corners,
    settings.unit,
    settings.temperatureUnit,
    undefined,
    segments,
    undefined,
    settings.language,
    undefined,
    insights,
  );

  const provider = settings.aiProvider;
  if (!provider) return { available: false, summary: "Lap Analyst unavailable — no AI provider selected." };
  await configureAiProviderEnvironment(provider, settings.localEndpoint || "http://localhost:1234/v1");

  const hideTools = provider === "openai-compatible";
  const result = await generate(prompt, {
    maxSteps: 5,
    ...(hideTools ? { activeTools: [] as never[] } : {}),
    modelSettings: { maxOutputTokens: 4096, temperature: 0 },
  });
  const text = typeof result.text === "string" ? result.text.trim() : "";
  return { available: true, summary: text || "Lap Analyst returned no content." };
}
}
