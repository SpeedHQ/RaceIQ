import { Hono } from "hono";
import { isOpponentPaceRenderParametersV1 } from "../../../shared/racing/live/engineer-contracts";
import { isSpotterStateV1 } from "../../../shared/racing/live/spotter-contracts";
import { renderOpponentPace, renderSpotter } from "../../live-strategy/live-engineer-renderer";
import { LIVE_ENGINEER_AUDIO_CATALOG_VERSION } from "../../../shared/racing/live/engineer-audio-catalog.generated";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const manifestPath = resolve(process.cwd(), "client/public/audio/live-engineer/v1/manifest.json");

export const liveEngineerRoutes = new Hono();
liveEngineerRoutes.get("/api/dev/live-engineer/catalog", (c) => {
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  return c.json({ catalogVersion: LIVE_ENGINEER_AUDIO_CATALOG_VERSION, pipelineVersion: manifest?.pipelineVersion ?? null, validation: existsSync(resolve(process.cwd(), "scripts/live-engineer/validation-report.json")), clipCount: manifest?.clips?.length ?? 0, lines: manifest?.clips ?? [] });
});

liveEngineerRoutes.post("/api/dev/live-engineer/catalog-check", async (c) => {
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  if (!manifest) return c.json({ passed: false, failures: ["missing manifest"] }, 500);
  return c.json({ passed: manifest.catalogVersion === LIVE_ENGINEER_AUDIO_CATALOG_VERSION, failures: manifest.catalogVersion === LIVE_ENGINEER_AUDIO_CATALOG_VERSION ? [] : ["catalog version mismatch"] });
});
liveEngineerRoutes.post("/api/dev/live-engineer/preview", async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (body && isSpotterStateV1(body.state)) {
    const rendered = renderSpotter(body.state);
    return c.json({ catalogVersion: LIVE_ENGINEER_AUDIO_CATALOG_VERSION, renderingVersion: "spotter-v1", textKey: rendered.textKey, text: rendered.text, parameters: { state: body.state, overlapCount: Number(body.overlapCount ?? 1) }, segmentIds: rendered.segmentIds, voiceMode: "automatic" });
  }
  if (!body || !isOpponentPaceRenderParametersV1(body)) return c.json({ error: "invalid render parameters" }, 400);
  const voiceMode = body.voiceMode === "exact-response" ? "exact-response" : "automatic";
  const rendered = renderOpponentPace(body, { voiceMode });
  return c.json({ catalogVersion: LIVE_ENGINEER_AUDIO_CATALOG_VERSION, renderingVersion: "opponent-pace-v1", textKey: rendered.textKey, text: rendered.text, parameters: body, segmentIds: rendered.segmentIds, voiceMode });
});
