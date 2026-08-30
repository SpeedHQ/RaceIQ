import { Hono } from "hono";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fullLineCatalog from "../../../shared/racing/live/full-lines.json";
import { createLiveEngineerVoiceLine, isOpponentPaceRenderParametersV1, isLiveEngineerCalloutMessageV3, LIVE_ENGINEER_AUDIO_CATALOG_VERSION, type OpponentPaceTextKeyV1, type SpotterTextKeyV1 } from "../../../shared/racing/live/engineer-contracts";
import { isSpotterStateV1 } from "../../../shared/racing/live/spotter-contracts";
import { renderLapTime, renderOpponentLapPace, renderOpponentPace, renderPreviewLine, renderSpotter } from "../../live-strategy/live-engineer-renderer";
import { wsManager } from "../../runtime/websocket-manager";

const root = process.cwd();
const qwenManifestPath = resolve(root, "client/public/audio/live-engineer/qwen-v2/manifest.json");
interface CatalogFullLine { lineId: string; spokenText: string; path: string; sha256: string; durationMs: number; }
interface CatalogQwenClip { segmentId: string; spokenText: string; path: string; sha256: string; durationMs: number; }
const qwenAudioRoot = resolve(root, "client/public/audio/live-engineer/qwen-v2");
const previewLineIds: Record<string, true> = Object.fromEntries(fullLineCatalog.filter((line) => line.kind === "preview-line").map((line) => [line.lineId, true]));
export const liveEngineerRoutes = new Hono();

liveEngineerRoutes.get("/api/dev/live-engineer/catalog", (c) => {
  const qwenManifest = existsSync(qwenManifestPath) ? JSON.parse(readFileSync(qwenManifestPath, "utf8")) : null;
  const fullLines = (qwenManifest?.fullLines ?? []).map((line: CatalogFullLine) => ({ ...line, url: `/audio/live-engineer/qwen-v2/${line.path}` }));
  const qwenClips = (qwenManifest?.clips ?? []).map((clip: CatalogQwenClip) => ({ ...clip, url: `/audio/live-engineer/qwen-v2/${clip.path}` }));
  return c.json({ catalogVersion: LIVE_ENGINEER_AUDIO_CATALOG_VERSION, model: qwenManifest?.model ?? null, validation: Boolean(qwenManifest), fullLineValidation: qwenManifest?.fullLineValidation ?? null, fullLines, qwenClips });
});

liveEngineerRoutes.post("/api/dev/live-engineer/catalog-check", async (c) => {
  const failures: string[] = [];
  const qwenManifest = existsSync(qwenManifestPath) ? JSON.parse(readFileSync(qwenManifestPath, "utf8")) : null;
  if (!qwenManifest) failures.push("missing Qwen manifest");
  for (const line of (qwenManifest?.fullLines ?? []) as CatalogFullLine[]) {
    const file = resolve(qwenAudioRoot, line.path);
    if (!existsSync(file)) { failures.push(`missing Qwen asset: ${line.lineId}`); continue; }
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (hash !== line.sha256) failures.push(`Qwen hash mismatch: ${line.lineId}`);
  }
  for (const clip of (qwenManifest?.clips ?? []) as CatalogQwenClip[]) {
    const file = resolve(qwenAudioRoot, clip.path);
    if (!existsSync(file)) { failures.push(`missing Qwen clip: ${clip.segmentId}`); continue; }
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
    if (!rendered.segmentIds.length) return c.json({ error: "invalid lap time" }, 400);
    return c.json({ type: "live-engineer-lap-time-preview", text: rendered.text, voiceLine: { segmentIds: rendered.segmentIds } });
  }
  if (body?.kind === "opponent-lap-pace") {
    const rendered = renderOpponentLapPace({
      relation: "within-class-pace",
      scope: "class",
      playerLapNumber: Number(body.playerLapNumber ?? 1),
      playerLapTimeMs: Number(body.playerLapTimeMs ?? 60_400),
      benchmarkLapTimeMs: Number(body.benchmarkLapTimeMs ?? 60_000),
      deltaMs: Number(body.deltaMs ?? 400),
      benchmarkKind: "session-best",
    });
    return c.json({ type: "live-engineer-opponent-lap-pace-preview", text: rendered.text, voiceLine: { segmentIds: rendered.segmentIds } });
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
  const rendered = renderOpponentPace(body, { voiceMode: "automatic" });
  const candidateId = `dev/${now}/${body.relation}`;
  const message = { type: "live-engineer-callout" as const, protocolVersion: 3 as const, decisionId: `${candidateId}/opponent-pace-v1`, candidateId, family: "opponent-pace" as const, sessionId: "dev", timelineEpoch: 1, sourceSequence: now, priority: "normal" as const, createdSessionTimeMs: now, expiresSessionTimeMs: now + 12_000, render: { renderingVersion: "opponent-pace-v1" as const, textKey: rendered.textKey as OpponentPaceTextKeyV1, parameters: body } };
  if (!isLiveEngineerCalloutMessageV3(message)) return c.json({ error: "renderer produced invalid pace message" }, 500);
  wsManager.broadcastNotification(message as unknown as Record<string, unknown>);
  const line = createLiveEngineerVoiceLine(message, rendered.segmentIds, { mode: "automatic" });
  wsManager.broadcastNotification(line as unknown as Record<string, unknown>);
  return c.json({ ...message, text: rendered.text, voiceLine: line });
});
