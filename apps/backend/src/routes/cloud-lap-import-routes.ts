import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { CloudLapImportState } from "@raceiq/shared/integrations/cloud-lap-import";
import { importCloudLap, CloudLapImportError, validateCloudLapImportUrl } from "@raceiq/backend-core/session-capture/cloud-lap-import";
import { getOnlineService } from "../integrations/online";

const body = z.union([
  z.object({ lapId: z.string().min(1).max(512) }).strict(),
  z.object({ url: z.string().min(1).max(4096) }).strict(),
]);
export interface CloudLapImportControllerOptions {
  getAccessToken?: () => Promise<string | null>;
  importLap?: typeof importCloudLap;
}

export function createCloudLapImportController(options: CloudLapImportControllerOptions = {}) {
  const idle: CloudLapImportState = { status: "idle", lapId: null, localLap: null, error: null, activationId: null };
  let state: CloudLapImportState = idle;
  type Intent = { lapId: string; sourceUrl: string | null; activationId: number };
  const pending: Intent[] = [];
  let running: Promise<void> | null = null;
  let nextActivationId = Date.now();
  let completionObserved = true;
  const getAccessToken = options.getAccessToken ?? (() => getOnlineService().getImportAccessToken());
  const importLap = options.importLap ?? importCloudLap;

  function enqueue(lapId: string, sourceUrl: string | null): CloudLapImportState {
    const existing = pending.find((intent) => intent.lapId === lapId);
    if (existing) return { status: "awaiting_sign_in", lapId, localLap: null, error: null, activationId: existing.activationId };
    if (pending.length >= 32) throw new CloudLapImportError("import_busy", true);
    const intent = { lapId, sourceUrl, activationId: nextActivationId++ };
    pending.push(intent);
    if (!running && (state.status !== "complete" || completionObserved)) {
      state = { status: "awaiting_sign_in", lapId, localLap: null, error: null, activationId: intent.activationId };
      void runImport().catch(() => undefined);
    }
    return state.status === "complete" && !completionObserved || running && state.activationId !== intent.activationId
      ? { status: "awaiting_sign_in", lapId, localLap: null, error: null, activationId: intent.activationId }
      : state;
  }

  async function dispatchCloudLapImport(url: string): Promise<CloudLapImportState> {
    const lapId = lapIdForUrl(url);
    return enqueue(lapId, new URL(url).searchParams.get("url"));
  }

  async function runImport() {
    if (running || !pending.length || (state.status === "complete" && !completionObserved)) return running;
    const intent = pending[0]!;
    running = (async () => {
      try {
        const token = await getAccessToken();
        if (!token) {
          state = { status: "awaiting_sign_in", lapId: intent.lapId, localLap: null, error: null, activationId: intent.activationId };
          return;
        }
        state = { status: "downloading", lapId: intent.lapId, localLap: null, error: null, activationId: intent.activationId };
        const result = await importLap({ lapId: intent.lapId, sourceUrl: intent.sourceUrl, accessToken: token, onState(status) { state = { status, lapId: intent.lapId, localLap: null, error: null, activationId: intent.activationId }; } });
        state = { status: "complete", lapId: intent.lapId, localLap: result, error: null, activationId: intent.activationId };
        completionObserved = false;
        pending.shift();
      } catch (cause) {
        const error = cause instanceof CloudLapImportError ? cause : new CloudLapImportError("download_failed", true);
        if (error.code === "auth_required") {
          state = { status: "awaiting_sign_in", lapId: intent.lapId, localLap: null, error: null, activationId: intent.activationId };
          return;
        }
        state = { status: "error", lapId: intent.lapId, localLap: null, error: { code: error.code, retryable: error.retryable }, activationId: intent.activationId };
        completionObserved = false;
        if (!error.retryable) pending.shift();
      }
    })().finally(() => { running = null; });
    return running;
  }

  const routes = new Hono()
    .get("/api/online/lap-import", async (c) => {
      const responseState = state;
      if (state.status === "awaiting_sign_in") void runImport().catch(() => undefined);
      if (state.status === "error" && !completionObserved) {
        completionObserved = true;
        if (pending.length && state.error?.retryable === false) {
          const next = pending[0]!;
          state = { status: "awaiting_sign_in", lapId: next.lapId, localLap: null, error: null, activationId: next.activationId };
          void runImport().catch(() => undefined);
        }
      }
      return c.json(responseState);
    })
    .post("/api/online/lap-import/ack", zValidator("json", z.object({ activationId: z.number().int().positive() }).strict()), async (c) => {
      const { activationId } = c.req.valid("json");
      if (state.status !== "complete" || state.activationId !== activationId) return c.json(state, 409);
      completionObserved = true;
      if (pending.length) {
        const next = pending[0]!;
        state = { status: "awaiting_sign_in", lapId: next.lapId, localLap: null, error: null, activationId: next.activationId };
        void runImport().catch(() => undefined);
      } else {
        state = idle;
      }
      return c.json(state, 200);
    })
    .post("/api/online/lap-import", zValidator("json", body), async (c) => {
      const request = c.req.valid("json");
      try {
        const lapId = "url" in request ? lapIdForUrl(request.url) : request.lapId;
        const next = enqueue(lapId, "url" in request ? new URL(request.url).searchParams.get("url") : null);
        return c.json(next, 202);
      } catch (cause) {
        const error = cause instanceof CloudLapImportError ? cause : new CloudLapImportError("invalid_request", false);
        const rejected: CloudLapImportState = { status: "error", lapId: null, localLap: null, error: { code: error.code, retryable: error.retryable }, activationId: null };
        return c.json(rejected, 400);
      }
    })
    .post("/api/online/lap-import/retry", zValidator("json", z.object({}).strict()), async (c) => {
      const intent = pending[0];
      if (!intent || state.status !== "error" && state.status !== "awaiting_sign_in") return c.json(state, 409);
      state = { status: "awaiting_sign_in", lapId: intent.lapId, localLap: null, error: null, activationId: intent.activationId };
      void runImport().catch(() => undefined);
      return c.json(state, 202);
    });

  return { routes, dispatchCloudLapImport };
}

const productionController = createCloudLapImportController();
export const cloudLapImportRoutes = productionController.routes;
export const dispatchCloudLapImport = productionController.dispatchCloudLapImport;

function lapIdForUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CloudLapImportError("invalid_url", false); }
  const selectors = [...url.searchParams.entries()];
  if (url.protocol !== "raceiq:" || url.hostname !== "import" || url.port || (url.pathname !== "" && url.pathname !== "/") || url.username || url.password || url.hash || selectors.length !== 1 || selectors[0]?.[0] !== "url") throw new CloudLapImportError("invalid_url", false);
  return validateCloudLapImportUrl(selectors[0]![1]);
}





