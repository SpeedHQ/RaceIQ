import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { transferRoutes } from "../../server/routes/laps/transfer-routes";

const MOTEC_ARCHIVE = "test/artifacts/motec/acc-barcelona-porsche-992.zip";

describe("ZIP import ownership validation", () => {
  test.each([
    ["missing", undefined],
    ["invalid", "everyone"],
  ])("rejects %s ownership", async (_label, ownership) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array()], "laps.zip"));
    if (ownership) form.append("ownership", ownership);
    const response = await transferRoutes.request("/api/laps/import-zip", { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ownership must be exactly mine or others" });
  });
});

test("detects MoTeC LD and LDX archive", async () => {
  const form = new FormData();
  form.append("file", new File([readFileSync(MOTEC_ARCHIVE)], "Barcelona-992-MoTeC.zip"));
  const response = await transferRoutes.request("/api/laps/detect-import", { method: "POST", body: form });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    format: "motec",
    supported: true,
    captureCount: 1,
  });
});
