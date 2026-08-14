import { afterAll, describe, expect, test } from "bun:test";
import type { GameId } from "../../shared/games/ids";
import type { SourceLifecycleEvidence } from "../../shared/racing/quality/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { UdpListener, type UdpListenerDependencies } from "../../server/runtime/udp-listener";
import { stopMaintenanceTasks, type LiveSourceScope } from "../../server/telemetry/live-pipeline";

class UdpListenerHarness extends UdpListener {
  ingest(sourceFrame: Buffer): Promise<void> {
    return this.handlePacket(sourceFrame);
  }

  forceTimeout(gameId: GameId): void {
    Object.assign(this, {
      _receiving: false,
      _timedOut: true,
      _activeSourceGame: gameId,
      _timedOutSourceGame: gameId,
      _activeSourceSessionId: 42,
      _timedOutSourceSessionId: 42,
    });
  }
}

afterAll(() => stopMaintenanceTasks());

describe("UDP source lifecycle", () => {
  test("ignores invalid post-timeout datagrams and records reconnect immediately before next accepted packet", async () => {
    const order: string[] = [];
    const lifecycleEvents: Array<{ event: SourceLifecycleEvidence; source?: LiveSourceScope }> = [];
    const acceptedPacket = { gameId: "fm-2023" } as TelemetryPacket;
    const dependencies: UdpListenerDependencies = {
      parsePacket: (sourceFrame) => (sourceFrame[0] === 1 ? acceptedPacket : null),
      processPacket: async () => {
        order.push("process");
      },
      noteSourceLifecycle: (event, source) => {
        lifecycleEvents.push({ event, source });
        order.push(event.kind);
      },
    };
    const listener = new UdpListenerHarness(dependencies);
    listener.forceTimeout("fm-2023");

    await listener.ingest(Buffer.alloc(29));

    expect(lifecycleEvents).toHaveLength(0);
    expect(listener.receiving).toBe(false);

    const accepted = Buffer.alloc(29);
    accepted[0] = 1;
    await listener.ingest(accepted);

    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0]).toMatchObject({
      event: { kind: "reconnect" },
      source: { kind: "udp", gameId: "fm-2023", sessionId: 42 },
    });
    expect(order).toEqual(["reconnect", "process"]);
    expect(listener.receiving).toBe(true);
  });
});
