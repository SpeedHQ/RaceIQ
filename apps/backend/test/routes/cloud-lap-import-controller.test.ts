import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createCloudLapImportController } from "../../src/routes/cloud-lap-import-routes";

const lap = { id: 17, gameId: "fm-2023", sessionId: 23 };
type TestController = { routes: Hono };

async function state(controller: TestController) {
  const response = await controller.routes.request("/api/online/lap-import");
  return await response.json() as { status: string; activationId: number | null };
}

async function waitForComplete(controller: TestController) {
  for (let i = 0; i < 20; i++) {
    const current = await state(controller);
    if (current.status === "complete") return current;
    await Promise.resolve();
  }
  throw new Error("Import did not complete");
}

describe("cloud lap import controller completion acknowledgement", () => {
  test("GET does not acknowledge completion; matching acknowledgement advances queued work", async () => {
    let imported = 0;
    const controller = createCloudLapImportController({
      getAccessToken: async () => "token",
      importLap: async () => { imported++; return lap; },
    });
    await controller.routes.request("/api/online/lap-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lapId: "first" }) });
    const first = await waitForComplete(controller);
    await controller.routes.request("/api/online/lap-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lapId: "second" }) });
    expect((await state(controller)).activationId).toBe(first.activationId);
    expect(imported).toBe(1);
    const staleAck = await controller.routes.request("/api/online/lap-import/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activationId: first.activationId! + 1 }) });
    expect(staleAck.status).toBe(409);
    const ack = await controller.routes.request("/api/online/lap-import/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activationId: first.activationId }) });
    expect(ack.status).toBe(200);
    const second = await waitForComplete(controller);
    expect(second.activationId).not.toBe(first.activationId);
    expect(imported).toBe(2);
  });

  test("acknowledging completion with no queue clears historical completion", async () => {
    const controller = createCloudLapImportController({ getAccessToken: async () => "token", importLap: async () => lap });
    await controller.routes.request("/api/online/lap-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lapId: "first" }) });
    const completed = await waitForComplete(controller);
    const response = await controller.routes.request("/api/online/lap-import/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activationId: completed.activationId }) });
    expect(response.status).toBe(200);
    expect((await state(controller)).status).toBe("idle");
  });
});
