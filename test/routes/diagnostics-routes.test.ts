import { describe, expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { diagnosticsRoutes } from "../../server/routes/system/diagnostics-routes";

describe("diagnostics export", () => {
  test("includes accepted client event and chat context in logs", async () => {
    const occurredAtMs = Date.parse("2026-09-17T12:34:56.000Z");
    const clientResponse = await diagnosticsRoutes.request("/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "info", scope: "route-test", message: "client event", occurredAtMs, detail: { useful: true } }),
    });
    expect(clientResponse.status).toBe(200);

    const response = await diagnosticsRoutes.request("/api/diagnostics");
    expect(response.status).toBe(200);
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const logs = strFromU8(archive["logs.txt"]);
    expect(logs).toContain("=== RaceIQ AI conversation context ===");
    expect(logs).toContain("client event");
    expect(logs).toContain("2026-09-17T12:34:56.000Z");
    const clientLine = logs.split("\n").findLast((line) => line.startsWith("20") && line.includes("client event"));
    expect(clientLine).toMatch(/^20\d{2}-\d{2}-\d{2}T.*Z INFO {2}\[raceiq\] \[Client\/route-test\] client event\t/);
    expect(JSON.parse(clientLine!.slice(clientLine!.indexOf("\t") + 1))).toMatchObject({
      clientOccurredAt: "2026-09-17T12:34:56.000Z",
      clientScope: "route-test",
      clientDetail: { useful: true },
    });
  });
});
