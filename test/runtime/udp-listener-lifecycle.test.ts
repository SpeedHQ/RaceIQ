import { afterAll, describe, expect, spyOn, test } from "bun:test";
import type { GameId } from "../../shared/games/ids";
import type { SourceLifecycleEvidence } from "../../shared/racing/quality/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { UdpListener, type UdpListenerDependencies } from "../../server/runtime/udp-listener";
import { stopMaintenanceTasks, type LiveSourceScope } from "../../server/telemetry/live-pipeline";

class UdpListenerHarness extends UdpListener {
  ingest(sourceFrame: Buffer): Promise<void> {
    return this.handlePacket(sourceFrame);
  }

  enqueue(sourceFrame: Buffer): Promise<void> {
    return this._enqueuePacket(sourceFrame);
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
      noteSourceLifecycle: async (event, source) => {
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

  test("serializes accepted packets and drains them before stop resolves", async () => {
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const dependencies: UdpListenerDependencies = {
      parsePacket: (sourceFrame) => ({ gameId: "fm-2023", TimestampMS: sourceFrame[0] } as TelemetryPacket),
      processPacket: async (packet) => {
        const packetId = packet.TimestampMS;
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(packetId);
        if (packetId === 1) {
          markFirstStarted();
          await firstGate;
        } else {
          markSecondStarted();
          await secondGate;
        }
        active--;
      },
      noteSourceLifecycle: async () => {},
    };
    const listener = new UdpListenerHarness(dependencies);
    const first = Buffer.alloc(29, 1);
    const second = Buffer.alloc(29, 2);

    const firstPacket = listener.enqueue(first);
    const secondPacket = listener.enqueue(second);
    await firstStarted;

    let stopSettled = false;
    const stop = listener.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(order).toEqual([1]);

    releaseFirst();
    await secondStarted;
    expect(stopSettled).toBe(false);
    expect(order).toEqual([1, 2]);

    releaseSecond();
    await Promise.all([firstPacket, secondPacket, stop]);
    expect(maxActive).toBe(1);
    expect(stopSettled).toBe(true);
  });

  test("contains rejected packet handlers and continues queue processing", async () => {
    const failure = new Error("packet failed");
    const processed: number[] = [];
    const error = spyOn(console, "error").mockImplementation(() => {});
    const dependencies: UdpListenerDependencies = {
      parsePacket: (sourceFrame) => ({ gameId: "fm-2023", TimestampMS: sourceFrame[0] } as TelemetryPacket),
      processPacket: async (packet) => {
        const packetId = packet.TimestampMS;
        processed.push(packetId);
        if (packetId === 1) throw failure;
      },
      noteSourceLifecycle: async () => {},
    };
    const listener = new UdpListenerHarness(dependencies);

    try {
      await Promise.all([
        listener.enqueue(Buffer.alloc(29, 1)),
        listener.enqueue(Buffer.alloc(29, 2)),
      ]);
      expect(processed).toEqual([1, 2]);
      expect(error).toHaveBeenCalledWith("[UDP] Packet processing failed:", failure);
    } finally {
      error.mockRestore();
      await listener.stop();
    }
  });
});
