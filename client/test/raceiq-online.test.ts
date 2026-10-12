import { describe, expect, it } from "bun:test";
import type { OnlineCommandResult, OnlineState } from "@raceiq/shared/integrations/raceiq-online";
import { clearOnlineStateCache, readOnlineStateCache, writeOnlineStateCache } from "../src/lib/raceiq-online-state-cache";
import { isCurrentOnlineGeneration, isOnlineLeaderboard, isOnlineState, isOnlineStateRevisionCurrent, OnlineTransportFailure, receiveOnlineResponse } from "../src/lib/raceiq-online";

const onlineState = (accountEpoch = "epoch-a", revision = 1): OnlineState => ({
  contractVersion: 1, revision, accountEpoch, service: "available",
  connection: { status: "signed_out" },
  policy: { status: "available", versions: { termsVersion: "terms-1", privacyVersion: "privacy-1" }, termsUrl: "https://raceiq.example/terms", privacyUrl: "https://raceiq.example/privacy" },
  consent: { status: "not_accepted" }, preferences: null, persistedPreferences: null,
  preferencePersistence: "unconfirmed", uploadAllowed: false,
  sync: { status: "idle", blockedBy: null, queued: 0, inFlight: 0, rejected: 0, lastSyncedAt: null, lastError: null },
  publicationWithdrawal: { status: "none", error: null },
});
const failure = (state: OnlineState): OnlineCommandResult => ({ ok: false, state, error: { code: "stale_state", retryable: true, retryAfter: null } });

describe("RaceIQ Online DTO and response validation", () => {
  it("validates full state fields and rejects malformed nested values", () => {
    const state = onlineState();
    expect(isOnlineState(state)).toBe(true);
    expect(isOnlineState({ ...state, sync: { ...state.sync, queued: -1 } })).toBe(false);
    expect(isOnlineState({ ...state, consent: { status: "accepted", versions: { termsVersion: "t", privacyVersion: "p" }, acceptedAt: "yesterday" } })).toBe(false);
    expect(isOnlineState({ ...state, preferencePersistence: "unknown" })).toBe(false);
  });

  it("accepts optional nullable Discord names and rejects invalid account fields", () => {
    const state = onlineState();
    const connected = (account: Record<string, unknown>) => ({ ...state, connection: { status: "connected", account } });
    const account = { userId: "user", displayName: "Leaderboard", avatarUrl: null };
    expect(isOnlineState(connected(account))).toBe(true);
    expect(isOnlineState(connected({ ...account, discordUsername: null }))).toBe(true);
    expect(isOnlineState(connected({ ...account, discordUsername: "DiscordUser" }))).toBe(true);
    expect(isOnlineState(connected({ ...account, discordUsername: "" }))).toBe(false);
    expect(isOnlineState(connected({ ...account, discordUsername: 42 }))).toBe(false);
    expect(isOnlineState(connected({ ...account, unexpected: true }))).toBe(false);
  });

  it("validates board identities, integer lap fields, and status-row consistency", () => {
    const board = { key: { gameId: "f1-2025", trackId: "track", carId: "car" }, status: "ready", rows: [{ rank: 1, lapId: "lap", driver: { userId: "public-user", displayName: "Driver", avatarUrl: null }, lapTimeMs: 91_234 }], fetchedAt: "2026-10-12T10:00:00Z", stale: false, error: null };
    expect(isOnlineLeaderboard(board)).toBe(true);
    expect(isOnlineLeaderboard({ ...board, rows: [{ ...board.rows[0], rank: 1.5 }] })).toBe(false);
    expect(isOnlineLeaderboard({ ...board, rows: [], status: "ready" })).toBe(false);
    expect(isOnlineLeaderboard({ ...board, status: "unavailable", rows: [], error: { code: "sharing_required", retryable: false, retryAfter: null } })).toBe(true);
  });

  it("accepts documented failure responses but rejects success bodies on failure status", async () => {
    const failureResult = failure(onlineState());
    await expect(receiveOnlineResponse(new Response(JSON.stringify(failureResult), { status: 409 }), (value): value is OnlineCommandResult => typeof value === "object" && value !== null && "ok" in value && "state" in value && isOnlineState(value.state), [200, 409])).resolves.toEqual(failureResult);
    await expect(receiveOnlineResponse(new Response(JSON.stringify({ ok: true, state: onlineState() }), { status: 503 }), (value): value is OnlineCommandResult => typeof value === "object" && value !== null && "ok" in value && "state" in value && isOnlineState(value.state), [200, 503])).rejects.toBeInstanceOf(OnlineTransportFailure);
    await expect(receiveOnlineResponse(new Response("{}", { status: 418 }), isOnlineState, [200])).rejects.toMatchObject({ kind: "transport", code: "invalid_response", retryable: false });
  });
  it("accepts only validated display snapshots and never persists unknown fields", () => {
    const values = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => { values.delete(key); },
    } });
    try {
      const state = onlineState();
      writeOnlineStateCache(state);
      expect(readOnlineStateCache()).toEqual(state);
      values.set("raceiq-online-state-v1", JSON.stringify({ ...state, secret: "token" }));
      expect(readOnlineStateCache()).toBeUndefined();
      expect(values.has("raceiq-online-state-v1")).toBe(false);
      values.set("raceiq-online-state-v1", "{broken");
      expect(readOnlineStateCache()).toBeUndefined();
      expect(values.has("raceiq-online-state-v1")).toBe(false);
      writeOnlineStateCache(state);
      clearOnlineStateCache();
      expect(readOnlineStateCache()).toBeUndefined();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, "localStorage");
      else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
    }
  });
  it("rejects late generations and older revisions without ordering opaque epochs", () => {
    const first = onlineState("epoch-a", 8);
    expect(isCurrentOnlineGeneration(4, 4)).toBe(true);
    expect(isCurrentOnlineGeneration(4, 5)).toBe(false);
    expect(isOnlineStateRevisionCurrent(first, onlineState("epoch-a", 7))).toBe(false);
    expect(isOnlineStateRevisionCurrent(first, onlineState("epoch-z", 0))).toBe(true);
  });
});
