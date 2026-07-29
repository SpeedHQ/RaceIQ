import { describe, expect, test } from "bun:test";
import { buildWebSocketUrl } from "../client/src/hooks/websocket-url";

describe("RaceIQ WebSocket URL", () => {
  test("uses the current origin outside development", () => {
    expect(
      buildWebSocketUrl({
        protocol: "https:",
        hostname: "app.raceiq.example",
        host: "app.raceiq.example",
      }),
    ).toBe("wss://app.raceiq.example/ws");
  });

  test("bypasses the Vite proxy during local development", () => {
    expect(
      buildWebSocketUrl(
        {
          protocol: "http:",
          hostname: "raceiq.localhost",
          host: "raceiq.localhost:1355",
        },
        {
          protocol: "ws:",
          hostname: "",
          port: "3117",
        },
      ),
    ).toBe("ws://raceiq.localhost:3117/ws");
  });

  test("honours an explicitly configured development server target", () => {
    expect(
      buildWebSocketUrl(
        {
          protocol: "http:",
          hostname: "raceiq.localhost",
          host: "raceiq.localhost:1355",
        },
        {
          protocol: "wss:",
          hostname: "telemetry.internal",
          port: "444",
        },
      ),
    ).toBe("wss://telemetry.internal:444/ws");
  });
});
