import { describe, expect, test } from "bun:test";
import { createRaceIqOnlineAdapter } from "../src/adapter";
import { createBoardIdentifierResolver, createNativeBoardIdentifierResolver } from "../src/identifiers";
import { getAllAccCars } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTracks } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";

describe("native leaderboard identifier resolution", () => {
  test("passes known catalog identifiers unchanged and rejects unknown local identifiers", () => {
    const resolver = createNativeBoardIdentifierResolver();
    const trackId = String(getAccTracks().keys().next().value);
    const carId = String(getAllAccCars()[0]!.id);
    const key = { gameId: "acc", trackId, carId };
    expect(resolver.resolve(key)).toEqual({ status: "mapped", key });
    expect(resolver.resolve({ ...key, gameId: "not-a-game" })).toEqual({ status: "unsupported_game" });
    expect(resolver.resolve({ ...key, trackId: "not-a-track" })).toEqual({ status: "unknown_track" });
    expect(resolver.resolve({ ...key, carId: "not-a-car" })).toEqual({ status: "unknown_car" });
  });
});

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
    const input = { gameId: "f1-2025" as const, filename: "recording.bin", recording, setup: new Uint8Array([5, 6]), idempotencyKey: "018f0f4e-7b00-7000-8000-000000000001", reservationToken: "persisted-reservation", consentAccepted: true, setupUploads: true, codec: null, isAuthorized: () => true };
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
      baseUrl: "https://example.test", credentials: async () => ({ accessToken: "test-token", consentAccepted: true }),
      identifiers: createBoardIdentifierResolver([{ local: key, canonical: { gameId: "acc", trackId: "canonical-track", carId: "canonical-car" } }]),
      fetch: Object.assign(async () => Response.json({
        items: [{ id: "public-lap", rank: 2, totalTimeMs: 91_234, importAvailable: true, driver: { userId: "public-driver", displayName: "Driver", avatarUrl: null, email: "private@example.test", discordId: "private-discord-id" } }],
        limit: 50, offset: 0, total: 1,
      }), { preconnect: globalThis.fetch.preconnect }),
    });
    const board = await adapter.getLeaderboard(key);
    expect(board.rows).toEqual([{ lapId: "public-lap", rank: 2, lapTimeMs: 91_234, importAvailable: true, driver: { userId: "public-driver", displayName: "Driver", avatarUrl: null } }]);
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
      baseUrl: "https://example.test", credentials: async () => ({ accessToken: "test-token", consentAccepted: true }), identifiers: resolver,
      fetch: Object.assign(async () => Response.json({ items: [{ rank: 1, id: "lap", totalTimeMs: 90_000, importAvailable: false, driver: null }], limit: 50, offset: 0, total: 1 }), { preconnect: globalThis.fetch.preconnect }),
    });
    await expect(adapter.getLeaderboard(key)).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  });
  test("recovers an already accepted upload from reservation conflict", async () => {
    const adapter = createRaceIqOnlineAdapter({
      baseUrl: "https://raceiq.example",
      credentials: async () => ({ accessToken: "test-token", consentAccepted: true }),
      identifiers: createBoardIdentifierResolver([]),
      fetch: Object.assign(async () => Response.json(
        { error: { code: "UPLOAD_ALREADY_ACCEPTED", message: "Upload already accepted" }, jobId: "accepted-job" },
        { status: 409 },
      ), { preconnect: globalThis.fetch.preconnect }),
    });
    const reservation = await adapter.reserveLapUpload({
      gameId: "acc",
      idempotencyKey: "018f0f4e-7b00-7000-8000-000000000001",
      consentAccepted: true,
      visibility: "public",
      isAuthorized: () => true,
    });
    expect(reservation).toEqual({ reservationToken: null, acceptedJobId: "accepted-job" });
  });
  test("does not start reservation transport when authorization changes during credential lookup", async () => {
    const credentialsGate = Promise.withResolvers<{ accessToken: string; consentAccepted: boolean }>();
    let authorized = true;
    let requests = 0;
    const adapter = createRaceIqOnlineAdapter({
      baseUrl: "https://raceiq.example",
      credentials: () => credentialsGate.promise,
      identifiers: createBoardIdentifierResolver([]),
      fetch: Object.assign(async () => { requests++; throw new Error("unexpected transport"); }, { preconnect: globalThis.fetch.preconnect }),
    });
    const reservation = adapter.reserveLapUpload({
      gameId: "acc", idempotencyKey: "018f0f4e-7b00-7000-8000-000000000001",
      consentAccepted: true, visibility: "public", isAuthorized: () => authorized,
    });
    authorized = false;
    credentialsGate.resolve({ accessToken: "test-token", consentAccepted: true });
    await expect(reservation).rejects.toMatchObject({ code: "not_connected", retryable: false });
    expect(requests).toBe(0);
  });
  test("does not start binary upload transport when authorization changes during credentials lookup", async () => {
    const credentialsGate = Promise.withResolvers<{ accessToken: string; consentAccepted: boolean }>();
    let authorized = true;
    let requests = 0;
    const adapter = createRaceIqOnlineAdapter({
      baseUrl: "https://raceiq.example",
      credentials: () => credentialsGate.promise,
      identifiers: createBoardIdentifierResolver([]),
      fetch: Object.assign(async () => { requests++; throw new Error("unexpected transport"); }, { preconnect: globalThis.fetch.preconnect }),
    });
    const upload = adapter.uploadLap({
      gameId: "acc", filename: "recording.bin", recording: new Uint8Array([1, 2, 3, 4]),
      idempotencyKey: "018f0f4e-7b00-7000-8000-000000000001", reservationToken: "reservation",
      consentAccepted: true, visibility: "public", setupUploads: false,
      codec: { recordingFormatId: "verified-fixture", supportsSetupAttachment: () => false, isServiceCompatible: () => true, stripF1SetupTelemetry: () => null, hasF1SetupTelemetry: () => false },
      isAuthorized: () => authorized,
    });
    authorized = false;
    credentialsGate.resolve({ accessToken: "test-token", consentAccepted: true });
    await expect(upload).rejects.toMatchObject({ code: "not_connected", retryable: false });
    expect(requests).toBe(0);
  });
  test("maps reservation lock and expiry responses as recoverable without acceptance", async () => {
    const createAdapter = (response: (request: Request) => Response) => createRaceIqOnlineAdapter({
      baseUrl: "https://raceiq.example",
      credentials: async () => ({ accessToken: "test-token", consentAccepted: true }),
      identifiers: createBoardIdentifierResolver([]),
      fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => response(new Request(input, init)), { preconnect: globalThis.fetch.preconnect }),
    });
    const reservationAdapter = createAdapter(() => Response.json({ error: { code: "LOCKED" } }, { status: 423, headers: { "Retry-After": "120" } }));
    await expect(reservationAdapter.reserveLapUpload({
      gameId: "acc", idempotencyKey: "018f0f4e-7b00-7000-8000-000000000001",
      consentAccepted: true, visibility: "public", isAuthorized: () => true,
    })).rejects.toMatchObject({ code: "rate_limited", retryable: true, responseStatus: 423, retryAfter: expect.any(String) });
    const expiredAdapter = createAdapter(() => Response.json({ error: { code: "UPLOAD_RESERVATION_EXPIRED", message: "Reservation expired" } }, { status: 409 }));
    await expect(expiredAdapter.uploadLap({
      gameId: "acc", filename: "recording.bin", recording: new Uint8Array([1, 2, 3, 4]),
      idempotencyKey: "018f0f4e-7b00-7000-8000-000000000001", reservationToken: "expired-reservation",
      consentAccepted: true, visibility: "public", setupUploads: false,
      codec: { recordingFormatId: "verified-fixture", supportsSetupAttachment: () => false, isServiceCompatible: () => true, stripF1SetupTelemetry: () => null, hasF1SetupTelemetry: () => false },
      isAuthorized: () => true,
    })).rejects.toMatchObject({ code: "service_unavailable", retryable: true, responseStatus: 409 });
  });
  test("authenticated writes use API Origin and uploads preserve game selector", async () => {
    const seen: Array<{ url: URL; method: string; origin: string | null; idempotencyKey: string | null; reservationToken: string | null }> = [];
    const adapter = createRaceIqOnlineAdapter({
      baseUrl: "https://raceiq.example",
      credentials: async () => ({ accessToken: "test-token", consentAccepted: true }),
      identifiers: createBoardIdentifierResolver([]),
      fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        seen.push({
          url: new URL(request.url), method: request.method, origin: request.headers.get("origin"),
          idempotencyKey: request.headers.get("idempotency-key"),
          reservationToken: request.headers.get("upload-reservation-token"),
        });
        if (request.method === "POST" && request.headers.get("content-type")?.startsWith("multipart/form-data")) {
          return Response.json({ id: "upload", status: "queued", processingAvailable: false, sizeBytes: 4, createdAt: "2026-10-12T00:00:00.000Z" }, { status: 202 });
        }
        if (request.method === "POST") return Response.json({ reservationToken: "persisted-reservation" }, { status: 201 });
        return new Response(null, { status: 204 });
      }, { preconnect: globalThis.fetch.preconnect }),
    });
    await adapter.unpublishLap("lap-1");
    const uploadKey = "018f0f4e-7b00-7000-8000-000000000001";
    const reservation = await adapter.reserveLapUpload({ gameId: "acc", idempotencyKey: uploadKey, consentAccepted: true, visibility: "public", isAuthorized: () => true });
    expect(reservation).toEqual({ reservationToken: "persisted-reservation", acceptedJobId: null });
    await adapter.uploadLap({
      gameId: "acc", filename: "recording.bin", recording: new Uint8Array([1, 2, 3, 4]),
      idempotencyKey: uploadKey, reservationToken: reservation.reservationToken!,
      consentAccepted: true, visibility: "public", setupUploads: false, codec: {
        recordingFormatId: "verified-fixture",
        supportsSetupAttachment: () => false,
        isServiceCompatible: () => true,
        stripF1SetupTelemetry: () => null,
        hasF1SetupTelemetry: () => false,
      },
      isAuthorized: () => true,
    });
    expect(seen).toHaveLength(3);
    expect(seen.every((request) => request.origin === "https://raceiq.example")).toBe(true);
    expect(seen[1]?.idempotencyKey).toBe(uploadKey);
    expect(seen[2]?.idempotencyKey).toBe(uploadKey);
    expect(seen[2]?.reservationToken).toBe("persisted-reservation");
    const upload = seen.find((request) => request.url.pathname === "/api/v1/laps" && request.reservationToken);
    expect(upload?.url.searchParams.get("gameId")).toBe("acc");
});
});
