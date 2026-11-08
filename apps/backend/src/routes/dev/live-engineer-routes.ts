import { Hono } from "hono";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import fullLineCatalog from "@raceiq/shared/racing/live/full-lines.json";
import { createLiveEngineerVoiceLine, isOpponentPaceRenderParametersV1, isLiveEngineerCalloutMessageV3, LIVE_ENGINEER_AUDIO_CATALOG_VERSION, type OpponentPaceTextKeyV1, type SpotterTextKeyV1 } from "@raceiq/shared/racing/live/engineer-contracts";
import { isSpotterStateV1 } from "@raceiq/shared/racing/live/spotter-contracts";
import { renderLapTime, renderOpponentLapPace, renderOpponentPace, renderPreviewLine, renderSpotter } from "@raceiq/live-engineer/live-engineer-renderer";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";

const sourceAudioRoot = fileURLToPath(new URL("../../../../../assets/live-engineer/qwen-v3", import.meta.url));
const audioUrl = "/api/dev/live-engineer/audio/";
interface CatalogFullLine { lineId: string; spokenText: string; path: string; sha256: string; durationMs: number; }
interface CatalogQwenClip { segmentId: string; spokenText: string; path: string; sha256: string; durationMs: number; }
const previewLineIds: Record<string, true> = Object.fromEntries(fullLineCatalog.filter((line) => line.kind === "preview-line").map((line) => [line.lineId, true]));
export function createLiveEngineerRoutes(qwenAudioRoot = sourceAudioRoot) {
const liveEngineerRoutes = new Hono();
const sourceFile = (relative: string): string | null => {
  if (typeof relative !== "string" || !relative || relative.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\"))) return null;
  try {
    const root = realpathSync(qwenAudioRoot);
    const file = realpathSync(resolve(root, relative));
    return file.startsWith(root + sep) && statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
};

liveEngineerRoutes.get("/api/dev/live-engineer/audio/*", (c) => {
  if (process.env.NODE_ENV === "production") return c.notFound();
  const file = sourceFile(c.req.path.slice(audioUrl.length));
  return file ? new Response(Bun.file(file)) : c.notFound();
});

liveEngineerRoutes.get("/api/dev/live-engineer/catalog", (c) => {
  if (process.env.NODE_ENV === "production") return c.notFound();
  const manifestPath = sourceFile("manifest.json");
  if (!manifestPath) return c.json({ error: "Qwen audio catalog missing" }, 404);
  const qwenManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fullLines = (qwenManifest?.fullLines ?? []).map((line: CatalogFullLine) => ({ ...line, url: `${audioUrl}${line.path}` }));
  const qwenClips = (qwenManifest?.clips ?? []).map((clip: CatalogQwenClip) => ({ ...clip, url: `${audioUrl}${clip.path}` }));
  return c.json({ catalogVersion: qwenManifest?.catalogVersion ?? LIVE_ENGINEER_AUDIO_CATALOG_VERSION, model: qwenManifest?.model ?? null, validation: Boolean(qwenManifest), fullLineValidation: qwenManifest?.fullLineValidation ?? null, fullLines, qwenClips });
});

liveEngineerRoutes.post("/api/dev/live-engineer/catalog-check", async (c) => {
  if (process.env.NODE_ENV === "production") return c.notFound();
  const failures: string[] = [];
  const manifestPath = sourceFile("manifest.json");
  if (!manifestPath) return c.json({ passed: false, failures: ["missing Qwen manifest"] }, 404);
  const qwenManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const line of (qwenManifest?.fullLines ?? []) as CatalogFullLine[]) {
    const file = sourceFile(line.path);
    if (!file) { failures.push(`missing Qwen asset: ${line.lineId}`); continue; }
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (hash !== line.sha256) failures.push(`Qwen hash mismatch: ${line.lineId}`);
  }
  for (const clip of (qwenManifest?.clips ?? []) as CatalogQwenClip[]) {
    const file = sourceFile(clip.path);
    if (!file) { failures.push(`missing Qwen clip: ${clip.segmentId}`); continue; }
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (hash !== clip.sha256) failures.push(`Qwen clip hash mismatch: ${clip.segmentId}`);
  }
  return c.json({ passed: failures.length === 0, failures }, failures.length ? 500 : 200);
});

liveEngineerRoutes.post("/api/dev/live-engineer/preview", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const now = Date.now();
  if (body?.kind === "lap-time") {
    const rendered = renderLapTime(Number(body.lapTimeMs));
    if (!rendered.segmentIds.length) return c.json({ error: "unsupported spoken value" }, 400);
    return c.json({ type: "live-engineer-lap-time-preview", text: rendered.text, voiceLine: { segmentIds: rendered.segmentIds } });
  }
  if (body?.kind === "opponent-lap-pace") {
    const voiceMode = body.voiceMode === "exact-response" ? "exact-response" : body.voiceMode === "automatic" ? "automatic" : null;
    if (!voiceMode) return c.json({ error: "invalid voice mode" }, 400);
    const rendered = renderOpponentLapPace({
      relation: "within-class-pace",
      scope: "class",
      playerLapNumber: Number(body.playerLapNumber ?? 1),
      playerLapTimeMs: Number(body.playerLapTimeMs ?? 60_400),
      benchmarkLapTimeMs: Number(body.benchmarkLapTimeMs ?? 60_000),
      deltaMs: Number(body.deltaMs ?? 400),
      benchmarkKind: "session-best",
    }, { voiceMode });
    if (!rendered.segmentIds.length) return c.json({ error: "unsupported spoken value" }, 400);
    return c.json({ type: "live-engineer-opponent-lap-pace-preview", text: rendered.text, voiceLine: { segmentIds: rendered.segmentIds, mode: voiceMode } });
  }
  if (body?.kind === "preview-line" && typeof body.lineId === "string" && previewLineIds[body.lineId] === true) {
    const rendered = renderPreviewLine(body.lineId as Parameters<typeof renderPreviewLine>[0]);
    return c.json({ type: "live-engineer-preview-line", text: rendered.text, lineId: rendered.lineId });
  }
  if (body && isSpotterStateV1(body.state)) {
    const rendered = renderSpotter(body.state);
    const candidateId = `dev/${now}/spotter/${body.state}`;
    const message = { type: "live-engineer-callout" as const, protocolVersion: 3 as const, decisionId: `${candidateId}/spotter-v1`, candidateId, family: "spotter" as const, sessionId: "dev", timelineEpoch: 1, sourceSequence: now, priority: "normal" as const, createdSessionTimeMs: now, expiresSessionTimeMs: now + 2_000, render: { renderingVersion: "spotter-v1" as const, textKey: rendered.textKey as SpotterTextKeyV1, parameters: { state: body.state, overlapCount: Number(body.overlapCount ?? 1) } } };
    if (!isLiveEngineerCalloutMessageV3(message)) return c.json({ error: "renderer produced invalid spotter message" }, 500);
    wsManager.broadcastNotification(message as unknown as Record<string, unknown>);
    const line = rendered.segmentIds.length ? createLiveEngineerVoiceLine(message, rendered.segmentIds, { mode: "automatic" }) : null;
    if (line) wsManager.broadcastNotification(line as unknown as Record<string, unknown>);
    return c.json({ ...message, text: rendered.text, voiceLine: line });
  }
  if (!body || !isOpponentPaceRenderParametersV1(body)) return c.json({ error: "invalid render parameters" }, 400);
  const voiceMode = body.voiceMode === "exact-response" ? "exact-response" : body.voiceMode === "automatic" ? "automatic" : null;
  if (!voiceMode) return c.json({ error: "invalid voice mode" }, 400);
  const rendered = renderOpponentPace(body, { voiceMode });
  if (!rendered.segmentIds.length) return c.json({ error: "unsupported spoken value" }, 400);
  const candidateId = `dev/${now}/${body.relation}`;
  const message = { type: "live-engineer-callout" as const, protocolVersion: 3 as const, decisionId: `${candidateId}/opponent-pace-v1`, candidateId, family: "opponent-pace" as const, sessionId: "dev", timelineEpoch: 1, sourceSequence: now, priority: "normal" as const, createdSessionTimeMs: now, expiresSessionTimeMs: now + 12_000, render: { renderingVersion: "opponent-pace-v1" as const, textKey: rendered.textKey as OpponentPaceTextKeyV1, parameters: body } };
  if (!isLiveEngineerCalloutMessageV3(message)) return c.json({ error: "renderer produced invalid pace message" }, 500);
  wsManager.broadcastNotification(message as unknown as Record<string, unknown>);
  const line = createLiveEngineerVoiceLine(message, rendered.segmentIds, { mode: voiceMode, ...(voiceMode === "exact-response" ? { requestId: `dev/${now}` } : {}) } as never);
  wsManager.broadcastNotification(line as unknown as Record<string, unknown>);
  return c.json({ ...message, text: rendered.text, voiceLine: line });
});
return liveEngineerRoutes;
}

export const liveEngineerRoutes = createLiveEngineerRoutes();
