import { describe, expect, it } from "bun:test";
import { devTelemetryStore } from "../src/stores/dev-telemetry";
import { gameStore } from "../src/stores/game";
import { telemetryStore } from "../src/stores/telemetry";
import { uiStore } from "../src/stores/ui";

const schema = {
  type: "telemetry-schema",
  protocolVersion: 1,
  schemaId: "migration-schema",
  simulator: "acc",
  catalogVersion: "catalog",
  catalogHash: "hash",
  catalogSchemaVersion: "1",
  parserVersion: "parser",
  resolverVersion: "resolver",
  derivationVersion: "derivation",
  definitions: [],
} as const;

const frame = {
  type: "telemetry-frame",
  protocolVersion: 1,
  schemaId: schema.schemaId,
  streamId: "stream",
  sessionId: null,
  sequence: 1,
  observedAt: { domain: "session", milliseconds: 1 },
  receivedAtMs: 1,
  values: [],
  context: {},
} as const;

describe("TanStack store contracts", () => {
  it("preserves unrelated telemetry state across partial updates", () => {
    telemetryStore.actions.setPacketsPerSec(17);
    telemetryStore.actions.setConnected(true);
    expect(telemetryStore.get().packetsPerSec).toBe(17);
    expect(telemetryStore.get().connected).toBe(true);
  });

  it("retains frame and view when telemetry schema repeats", () => {
    telemetryStore.actions.clearTelemetry();
    telemetryStore.actions.setTelemetrySchema(schema);
    telemetryStore.actions.setTelemetryFrame(frame);
    const previousFrame = telemetryStore.get().telemetryFrame;
    const previousView = telemetryStore.get().telemetryView;
    telemetryStore.actions.setTelemetrySchema(schema);
    expect(telemetryStore.get().telemetryFrame).toBe(previousFrame);
    expect(telemetryStore.get().telemetryView).toBe(previousView);
  });

  it("clears laps on game switch while preserving unrelated telemetry", () => {
    gameStore.actions.setGameId("acc");
    telemetryStore.actions.setSessionLaps([{ lapId: 1, lapNumber: 1 } as never]);
    telemetryStore.actions.setPacketsPerSec(23);
    gameStore.actions.setGameId("iracing");
    expect(telemetryStore.get().sessionLaps).toEqual([]);
    expect(telemetryStore.get().packetsPerSec).toBe(23);
    gameStore.actions.setGameId(null);
  });

  it("supports UI open and close transitions", () => {
    uiStore.actions.openSettings("display");
    expect(uiStore.get().settingsOpen).toBe(true);
    expect(uiStore.get().settingsSection).toBe("display");
    uiStore.actions.closeSettings();
    expect(uiStore.get().settingsOpen).toBe(false);
  });

  it("clears dev telemetry while retaining subscription intent", () => {
    devTelemetryStore.actions.setSubscriptionWanted(true);
    devTelemetryStore.actions.setPacket(null);
    devTelemetryStore.actions.clear();
    expect(devTelemetryStore.get().subscriptionWanted).toBe(true);
    expect(devTelemetryStore.get().packet).toBeNull();
  });

  it("ignores dev snapshots while paused, then accepts them after resume", () => {
    telemetryStore.actions.setDevState({ value: "before" });
    telemetryStore.actions.toggleDevStatePause();
    telemetryStore.actions.setDevState({ value: "ignored" });
    expect(telemetryStore.get().devState).toEqual({ value: "before" });
    telemetryStore.actions.toggleDevStatePause();
    telemetryStore.actions.setDevState({ value: "after" });
    expect(telemetryStore.get().devState).toEqual({ value: "after" });
  });

  it("retains debug demand until all viewers close, including across reconnect", () => {
    const releasePage = telemetryStore.actions.acquireDevState();
    const releaseDevtools = telemetryStore.actions.acquireDevState();
    try {
      telemetryStore.actions.setConnected(false);
      telemetryStore.actions.setConnected(true);
      expect(telemetryStore.get().devStateConsumers).toBe(2);
      releasePage();
      releasePage();
      expect(telemetryStore.get().devStateConsumers).toBe(1);
      releaseDevtools();
      expect(telemetryStore.get().devStateConsumers).toBe(0);
    } finally {
      releasePage();
      releaseDevtools();
    }
  });

  it("exposes game and telemetry instances with actions", () => {
    gameStore.actions.setGameId("acc");
    expect(gameStore.get().gameId).toBe("acc");
    gameStore.actions.setGameId(null);
  });
});
