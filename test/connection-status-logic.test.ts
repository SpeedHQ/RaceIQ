import { describe, test, expect } from "bun:test";
import { deriveConnectionStatusView } from "../client/src/components/connection-status-logic";

const F1 = { id: "f1-2025", name: "F1 25" } as const;
const FORZA = { id: "fm-2023", name: "Forza Motorsport" } as const;

describe("deriveConnectionStatusView — server label", () => {
  test("shows 'Server' when connected", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: false, detectedGame: null });
    expect(view.serverLabel).toBe("Server");
  });

  test("shows 'Disconnected' when not connected", () => {
    const view = deriveConnectionStatusView({ connected: false, forzaReceiving: false, detectedGame: null });
    expect(view.serverLabel).toBe("Disconnected");
  });
});

describe("deriveConnectionStatusView — game text", () => {
  test("no game detected, no packets → 'No Signal' / dim", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: false, detectedGame: null });
    expect(view.gameText).toBe("No Signal");
    expect(view.gameLabel).toBeNull();
    expect(view.dotColor).toBe("dim");
  });

  test("game detected but not receiving → '<name> — Waiting' / amber", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: false, detectedGame: F1 });
    expect(view.gameText).toBe("F1 25 — Waiting");
    expect(view.gameLabel).toBe("F1 25");
    expect(view.dotColor).toBe("amber");
  });

  test("game detected AND receiving telemetry → '<name>' / cyan", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: true, detectedGame: FORZA });
    expect(view.gameText).toBe("Forza Motorsport");
    expect(view.gameLabel).toBe("Forza Motorsport");
    expect(view.dotColor).toBe("cyan");
  });

  test("receiving telemetry but no game label → 'Receiving' / cyan", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: true, detectedGame: null });
    expect(view.gameText).toBe("Receiving");
    expect(view.gameLabel).toBeNull();
    expect(view.dotColor).toBe("cyan");
  });
});

describe("deriveConnectionStatusView — regressions", () => {
  test("game exit clears the label (no stale '<name> — Waiting')", () => {
    // Simulate: was detected → detection cleared. UI must not cling to the old name.
    const afterExit = deriveConnectionStatusView({ connected: true, forzaReceiving: false, detectedGame: null });
    expect(afterExit.gameText).toBe("No Signal");
    expect(afterExit.gameLabel).toBeNull();
  });

  test("undefined detectedGame behaves like null", () => {
    const view = deriveConnectionStatusView({ connected: true, forzaReceiving: false, detectedGame: undefined });
    expect(view.gameText).toBe("No Signal");
    expect(view.dotColor).toBe("dim");
  });

  test("disconnected server still reports game detection when server-status cached", () => {
    // Edge case: server dropped the WS but last known detectedGame was F1.
    // The game chip is independent of the server chip.
    const view = deriveConnectionStatusView({ connected: false, forzaReceiving: false, detectedGame: F1 });
    expect(view.serverLabel).toBe("Disconnected");
    expect(view.gameText).toBe("F1 25 — Waiting");
  });
});
