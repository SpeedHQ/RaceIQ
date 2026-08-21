import { describe, expect, test } from "bun:test";
import { errorFromResponse } from "../src/lib/rpc-error";

describe("errorFromResponse", () => {
  test("preserves structured eligibility failure text", async () => {
    const response = new Response(JSON.stringify({ error: "Unknown: Quality has not been rebuilt from source telemetry." }), {
      status: 422,
      statusText: "Unprocessable Entity",
      headers: { "Content-Type": "application/json" },
    });

    expect((await errorFromResponse(response)).message).toBe("Unknown: Quality has not been rebuilt from source telemetry.");
  });

  test("keeps non-JSON endpoint failures actionable", async () => {
    const response = new Response("Not Found", { status: 404, statusText: "Not Found" });

    expect((await errorFromResponse(response)).message).toBe("404 Not Found — endpoint missing; restart the server if it's running older code.");
  });
});
