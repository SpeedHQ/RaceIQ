import { describe, expect, test } from "bun:test";
import { clientReleaseFeatures, loadClientReleaseFeatures } from "../src/lib/release-features";

const flags = {
  f1Experiments: true,
  iracingAdapter: true,
  ams2Adapter: true,
  liveSpotterEngineer: true,
  liveSpotterEngineerGameIds: ["acc", "iracing"],
};

describe("release feature bootstrap", () => {
  test("loads all flags from public authentication status before login", async () => {
    let requested = "";
    const fetcher = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return Response.json({ authenticated: false, features: flags });
    }) as typeof fetch;

    const result = await loadClientReleaseFeatures(fetcher);
    expect(requested).toBe("/api/auth/status");
    expect(result).toEqual(flags);
    expect(clientReleaseFeatures).toEqual(flags);
  });

  test("rejects unavailable or malformed status so bootstrap can retry", async () => {
    const previous = { ...clientReleaseFeatures, liveSpotterEngineerGameIds: [...clientReleaseFeatures.liveSpotterEngineerGameIds] };
    const unavailable = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(loadClientReleaseFeatures(unavailable)).rejects.toThrow("503");
    const malformed = (async () => Response.json({ features: { ...flags, liveSpotterEngineerGameIds: null } })) as typeof fetch;
    await expect(loadClientReleaseFeatures(malformed)).rejects.toThrow("invalid shape");
    expect(clientReleaseFeatures).toEqual(previous);
  });
});
