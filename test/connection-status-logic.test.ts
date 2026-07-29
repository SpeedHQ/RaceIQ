import { describe, test, expect } from "bun:test";
import { deriveConnectionStatusView } from "../client/src/components/connection-status-logic";

const F1 = { id: "f1-2025", name: "F1 25" } as const;
const FORZA = { id: "fm-2023", name: "Forza Motorsport" } as const;

describe("deriveConnectionStatusView — merged connection status", () => {
  test("shows 'Disconnected' / red when server is not connected", () => {
    const view = deriveConnectionStatusView({ connected: false, forzaReceiving: false, detectedGame: null });
    expect(view.statusKind).toBe("disconnected");
    expect(view.gameText).toBe("Disconnected");
    expect(view.dotColor).toBe("red");
  });

  test("server disconnected overrides cached game detection", () => {
    const view = deriveConnectionStatusView({ connected: false, forzaReceiving: false, detectedGame: F1 });
    expect(view.statusKind).toBe("disconnected");
    expect(view.gameText).toBe("Disconnected");
    expect(view.dotColor).toBe("red");
  });

  test("server connected, no game detected → base 'Server' / green", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: false, detectedGame: null });
    expect(view.statusKind).toBe("server");
    expect(view.gameText).toBe("Server");
    expect(view.gameLabel).toBeNull();
    expect(view.dotColor).toBe("green");
  });

  test("game detected but not receiving → '<name> — Waiting' / amber", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: false, detectedGame: F1 });
    expect(view.statusKind).toBe("waiting");
    expect(view.gameText).toBe("F1 25 — Waiting");
    expect(view.gameLabel).toBe("F1 25");
    expect(view.dotColor).toBe("amber");
  });

  test("game detected AND receiving telemetry → '<name>' / cyan", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: true, detectedGame: FORZA });
    expect(view.statusKind).toBe("receiving");
    expect(view.gameText).toBe("Forza Motorsport");
    expect(view.gameLabel).toBe("Forza Motorsport");
    expect(view.dotColor).toBe("cyan");
  });

  test("receiving telemetry but no game label → 'Receiving' / cyan", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: true, detectedGame: null });
    expect(view.statusKind).toBe("receiving");
    expect(view.gameText).toBe("Receiving");
    expect(view.gameLabel).toBeNull();
    expect(view.dotColor).toBe("cyan");
  });
});

describe("deriveConnectionStatusView — regressions", () => {
  test("game exit reverts to base 'Server' status (no stale '<name> — Waiting')", () => {
    const afterExit = deriveConnectionStatusView({ connected: true, forzaReceiving: false, detectedGame: null });
    expect(afterExit.statusKind).toBe("server");
    expect(afterExit.gameText).toBe("Server");
    expect(afterExit.gameLabel).toBeNull();
    expect(afterExit.dotColor).toBe("green");
  });

  test("undefined detectedGame behaves like null (falls back to base 'Server')", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: false, detectedGame: undefined });
    expect(view.statusKind).toBe("server");
    expect(view.gameText).toBe("Server");
    expect(view.dotColor).toBe("green");
  });
});
