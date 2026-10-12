import { describe, expect, test } from "bun:test";
import { createRaceIqOnlineAdapter } from "../../../integrations/raceiq-online/adapter";
import { createBoardIdentifierResolver } from "../../../integrations/raceiq-online/identifiers";

describe("Online adapter transfer boundary", () => {
  test("HTML service outage remains sanitized service_unavailable rather than offline", async () => {
    const adapter = createRaceIqOnlineAdapter({
      baseUrl: "https://example.test", credentials: async () => null,
      identifiers: createBoardIdentifierResolver([]),
      fetch: Object.assign(async () => new Response("<html>private upstream diagnostic</html>", { status: 502, headers: { "Content-Type": "text/html" } }), { preconnect: globalThis.fetch.preconnect }),
    });
    await expect(adapter.getPolicy()).rejects.toMatchObject({ code: "service_unavailable", retryable: true });
  });

  test("private or unverifiable F1 upload never invokes transport", async () => {
    let requests = 0;
    const adapter = createRaceIqOnlineAdapter({
      baseUrl: "https://example.test", credentials: async () => ({ accessToken: "test-only", consentAccepted: true }),
      identifiers: createBoardIdentifierResolver([]),
      fetch: Object.assign(async () => { requests++; throw new Error("unexpected transfer"); }, { preconnect: globalThis.fetch.preconnect }),
    });
    const recording = new Uint8Array([1, 2, 3, 4]);
    const input = { gameId: "f1-2025" as const, filename: "recording.bin", recording, setup: new Uint8Array([5, 6]), consentAccepted: true, setupUploads: true, codec: null };
    await expect(adapter.uploadLap({ ...input, visibility: "private" })).rejects.toMatchObject({ code: "not_connected" });
    await expect(adapter.uploadLap({ ...input, visibility: "public" })).rejects.toMatchObject({ code: "f1_sanitization_failed" });
    expect(requests).toBe(0);
    expect(recording).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("keeps session Discord account name separate and stable across leaderboard name patches", async () => {
    const createAdapter = (discordAccountName: string | null) => createRaceIqOnlineAdapter({
      baseUrl: "https://raceiq.example",
      credentials: async () => ({ accessToken: "test-token", consentAccepted: true, discordAccountName }),
      identifiers: createBoardIdentifierResolver([]),
      fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/me")) {
          return Response.json({ userId: "account-1", displayName: request.method === "PATCH" ? "Chosen Name Updated" : "Chosen Name", avatarUrl: "https://cdn.example/avatar.png" });
        }
        throw new Error("Account metadata must not require a separate auth request");
      }, { preconnect: globalThis.fetch.preconnect }),
    });
    const connected = createAdapter("Discord Account Name");
    expect(await connected.getMe()).toEqual({ userId: "account-1", displayName: "Chosen Name", avatarUrl: "https://cdn.example/avatar.png", discordUsername: "Discord Account Name" });
    expect(await connected.setDisplayName("Chosen Name Updated")).toEqual({ userId: "account-1", displayName: "Chosen Name Updated", avatarUrl: "https://cdn.example/avatar.png", discordUsername: "Discord Account Name" });
    expect((await createAdapter(null).getMe()).discordUsername).toBeNull();
  });
  test("maps published flat ranked laps without copying private identity fields", async () => {
    const key = { gameId: "acc", trackId: "local-track", carId: "local-car" };
    const adapter = createRaceIqOnlineAdapter({
      baseUrl: "https://example.test", credentials: async () => null,
      identifiers: createBoardIdentifierResolver([{ local: key, canonical: { gameId: "acc", trackId: "canonical-track", carId: "canonical-car" } }]),
      fetch: Object.assign(async () => Response.json({
        items: [{ id: "public-lap", rank: 2, totalTimeMs: 91_234, driver: { userId: "public-driver", displayName: "Driver", avatarUrl: null, email: "private@example.test", discordId: "private-discord-id" } }],
        limit: 50, offset: 0, total: 1,
      }), { preconnect: globalThis.fetch.preconnect }),
    });
    const board = await adapter.getLeaderboard(key);
    expect(board.rows).toEqual([{ lapId: "public-lap", rank: 2, lapTimeMs: 91_234, driver: { userId: "public-driver", displayName: "Driver", avatarUrl: null } }]);
    expect(board.status).toBe("ready");
    expect(board.stale).toBe(false);
  });

  test("rejects missing mappings and malformed ranked laps rather than guessing a board", async () => {
    const key = { gameId: "acc", trackId: "local-track", carId: "local-car" };
    const resolver = createBoardIdentifierResolver([{ local: key, canonical: key }]);
    expect(resolver.resolve({ ...key, gameId: "toString" })).toEqual({ status: "unsupported_game" });
    expect(resolver.resolve({ ...key, trackId: "missing-track" })).toEqual({ status: "unknown_track" });
    expect(resolver.resolve({ ...key, carId: "missing-car" })).toEqual({ status: "unknown_car" });
    const adapter = createRaceIqOnlineAdapter({
      baseUrl: "https://example.test", credentials: async () => null, identifiers: resolver,
      fetch: Object.assign(async () => Response.json({ items: [{ rank: 1, id: "lap", totalTimeMs: 90_000, driver: null }], limit: 50, offset: 0, total: 1 }), { preconnect: globalThis.fetch.preconnect }),
    });
    await expect(adapter.getLeaderboard(key)).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  });
  test("authenticated writes use API Origin and uploads preserve game selector", async () => {
    const seen: Array<{ url: URL; method: string; origin: string | null }> = [];
    const adapter = createRaceIqOnlineAdapter({
      baseUrl: "https://raceiq.example",
      credentials: async () => ({ accessToken: "test-token", consentAccepted: true }),
      identifiers: createBoardIdentifierResolver([]),
      fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        seen.push({ url: new URL(request.url), method: request.method, origin: request.headers.get("origin") });
        return request.method === "POST"
          ? Response.json({ id: "upload", status: "queued", processingAvailable: false, sizeBytes: 4, createdAt: "2026-10-12T00:00:00.000Z" }, { status: 202 })
          : new Response(null, { status: 204 });
      }, { preconnect: globalThis.fetch.preconnect }),
    });
    await adapter.unpublishLap("lap-1");
    await adapter.uploadLap({
      gameId: "acc", filename: "recording.bin", recording: new Uint8Array([1, 2, 3, 4]),
      consentAccepted: true, visibility: "public", setupUploads: false, codec: {
        recordingFormatId: "verified-fixture",
        supportsSetupAttachment: () => false,
        isServiceCompatible: () => true,
        stripF1SetupTelemetry: () => null,
        hasF1SetupTelemetry: () => false,
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen.every((request) => request.origin === "https://raceiq.example")).toBe(true);
    const upload = seen.find((request) => request.url.pathname === "/api/v1/laps");
    expect(upload?.url.searchParams.get("gameId")).toBe("acc");
  });
});
