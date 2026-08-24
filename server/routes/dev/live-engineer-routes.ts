import { Hono } from "hono";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLiveEngineerVoiceLine, isOpponentPaceRenderParametersV1, isLiveEngineerCalloutMessageV2, type OpponentPaceTextKeyV1, type SpotterTextKeyV1 } from "../../../shared/racing/live/engineer-contracts";
import { isSpotterStateV1 } from "../../../shared/racing/live/spotter-contracts";
import { LIVE_ENGINEER_AUDIO_CATALOG, LIVE_ENGINEER_AUDIO_CATALOG_VERSION } from "../../../shared/racing/live/engineer-audio-catalog.generated";
import { renderLapTime, renderOpponentPace, renderSpotter } from "../../live-strategy/live-engineer-renderer";
import { wsManager } from "../../runtime/websocket-manager";

const root = process.cwd();
const manifestPath = resolve(root, "client/public/audio/live-engineer/v1/manifest.json");
const qwenManifestPath = resolve(root, "client/public/audio/live-engineer/qwen-v1/manifest.json");
interface CatalogSegment { segmentId: string; url: string; sha256: string; durationMs: number; }
interface CatalogFullLine { lineId: string; spokenText: string; path: string; sha256: string; durationMs: number; }
const audioRoot = resolve(root, "client/public/audio/live-engineer/v1");
export const liveEngineerRoutes = new Hono();
const qwenAudioRoot = resolve(root, "client/public/audio/live-engineer/qwen-v1");

liveEngineerRoutes.get("/api/dev/live-engineer/catalog", (c) => {
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const qwenManifest = existsSync(qwenManifestPath) ? JSON.parse(readFileSync(qwenManifestPath, "utf8")) : null;
  const reportPath = resolve(root, "scripts/live-engineer/validation-report.json");
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
  const fullLines = (qwenManifest?.fullLines ?? []).map((line: CatalogFullLine) => ({ ...line, url: `/audio/live-engineer/qwen-v1/${line.path}` }));
  return c.json({ catalogVersion: LIVE_ENGINEER_AUDIO_CATALOG_VERSION, pipelineVersion: manifest?.pipelineVersion ?? null, validation: report?.passed === true, report, clipCount: manifest?.clips?.length ?? 0, lines: manifest?.clips ?? [], fullLineModel: qwenManifest?.model ?? null, fullLineValidation: qwenManifest?.fullLineValidation ?? null, fullLines });
});

liveEngineerRoutes.post("/api/dev/live-engineer/catalog-check", async (c) => {
  const failures: string[] = [];
  if (!existsSync(manifestPath)) failures.push("missing manifest");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  if (manifest && manifest.catalogVersion !== LIVE_ENGINEER_AUDIO_CATALOG_VERSION) failures.push("catalog version mismatch");
  for (const segment of LIVE_ENGINEER_AUDIO_CATALOG.segments as readonly CatalogSegment[]) {
    const file = resolve(audioRoot, segment.url.split("/").pop() ?? "");
    if (!existsSync(file)) { failures.push(`missing asset: ${segment.segmentId}`); continue; }
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (hash !== segment.sha256) failures.push(`hash mismatch: ${segment.segmentId}`);
  }
  const qwenManifest = existsSync(qwenManifestPath) ? JSON.parse(readFileSync(qwenManifestPath, "utf8")) : null;
  if (!qwenManifest) failures.push("missing Qwen full-line manifest");
  for (const line of (qwenManifest?.fullLines ?? []) as CatalogFullLine[]) {
    const file = resolve(qwenAudioRoot, line.path);
    if (!existsSync(file)) { failures.push(`missing Qwen asset: ${line.lineId}`); continue; }
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (hash !== line.sha256) failures.push(`Qwen hash mismatch: ${line.lineId}`);
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
  if (body && isSpotterStateV1(body.state)) {
    const rendered = renderSpotter(body.state);
    const candidateId = `dev/${now}/spotter/${body.state}`;
    const message = { type: "live-engineer-callout" as const, protocolVersion: 2 as const, decisionId: `${candidateId}/spotter-v1`, candidateId, family: "spotter" as const, sessionId: "dev", timelineEpoch: 1, sourceSequence: now, priority: "normal" as const, createdSessionTimeMs: now, expiresSessionTimeMs: now + 2_000, render: { renderingVersion: "spotter-v1" as const, textKey: rendered.textKey as SpotterTextKeyV1, parameters: { state: body.state, overlapCount: Number(body.overlapCount ?? 1) } } };
    if (!isLiveEngineerCalloutMessageV2(message)) return c.json({ error: "renderer produced invalid spotter message" }, 500);
    wsManager.broadcastNotification(message as unknown as Record<string, unknown>);
    const line = rendered.segmentIds.length ? createLiveEngineerVoiceLine(message, rendered.segmentIds, { mode: "automatic" }) : null;
    if (line) wsManager.broadcastNotification(line as unknown as Record<string, unknown>);
    return c.json({ ...message, text: rendered.text, voiceLine: line });
  }
  if (!body || !isOpponentPaceRenderParametersV1(body)) return c.json({ error: "invalid render parameters" }, 400);
  const rendered = renderOpponentPace(body, { voiceMode: "automatic" });
  const candidateId = `dev/${now}/${body.relation}`;
  const message = { type: "live-engineer-callout" as const, protocolVersion: 2 as const, decisionId: `${candidateId}/opponent-pace-v1`, candidateId, family: "opponent-pace" as const, sessionId: "dev", timelineEpoch: 1, sourceSequence: now, priority: "normal" as const, createdSessionTimeMs: now, expiresSessionTimeMs: now + 12_000, render: { renderingVersion: "opponent-pace-v1" as const, textKey: rendered.textKey as OpponentPaceTextKeyV1, parameters: body } };
  if (!isLiveEngineerCalloutMessageV2(message)) return c.json({ error: "renderer produced invalid pace message" }, 500);
  wsManager.broadcastNotification(message as unknown as Record<string, unknown>);
  const line = createLiveEngineerVoiceLine(message, rendered.segmentIds, { mode: "automatic" });
  wsManager.broadcastNotification(line as unknown as Record<string, unknown>);
  return c.json({ ...message, text: rendered.text, voiceLine: line });
});
