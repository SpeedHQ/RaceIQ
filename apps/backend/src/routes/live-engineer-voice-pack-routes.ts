import { Hono, type Context } from "hono";
import type { LiveEngineerVoicePackStatus } from "@raceiq/live-engineer/audio-package";
import { createLiveEngineerVoicePackService, type LiveEngineerVoicePackService } from "../runtime/live-engineer-voice-pack-service";

async function respondStatus(c: Context, service: LiveEngineerVoicePackService): Promise<Response> {
  c.header("Cache-Control", "no-store");
  try { return c.json(await service.getStatus()); }
  catch { return c.json({ error: "voice-package-status-failed" }, 500); }
}

export function createLiveEngineerVoicePackRoutes(service: LiveEngineerVoicePackService) {
  return new Hono()
    .get("/api/live-engineer/voice-pack", (c) => respondStatus(c, service))
    .post("/api/live-engineer/voice-pack/check", async (c) => {
      c.header("Cache-Control", "no-store");
      try { return c.json(await service.check()); }
      catch (error) {
        if (error instanceof Error && error.message === "feature-disabled") return c.json({ error: "feature-disabled" }, 403);
        return respondStatus(c, service);
      }
    })
    .post("/api/live-engineer/voice-pack/install", async (c) => {
      c.header("Cache-Control", "no-store");
      try { return c.json(await service.install()); }
      catch (error) {
        if (error instanceof Error && error.message === "feature-disabled") return c.json({ error: "feature-disabled" }, 403);
        if (error instanceof Error && error.message === "install-in-progress") return c.json({ error: "install-in-progress" }, 409);
        return c.json({ error: "voice-package-install-failed" }, 502);
      }
    });
}

const productionService = createLiveEngineerVoicePackService();
export const liveEngineerVoicePackRoutes = createLiveEngineerVoicePackRoutes(productionService);
export function checkAutomaticLiveEngineerVoicePackUpdate(): Promise<LiveEngineerVoicePackStatus> {
  return productionService.checkAutomatic();
}
export function startLiveEngineerVoicePackChecks(): () => void {
  return productionService.startAutomaticChecks();
}
