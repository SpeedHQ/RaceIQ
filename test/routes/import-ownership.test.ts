import { describe, expect, test } from "bun:test";
import { transferRoutes } from "../../server/routes/laps/transfer-routes";

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
