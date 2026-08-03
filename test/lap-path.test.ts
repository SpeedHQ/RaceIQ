import { describe, expect, test } from "bun:test";
import {
  hasWorldPositions,
  integratePositions,
  lapPath,
  pointAtLapFraction,
  type LapPathSemanticId,
  type LapPathSemanticReader,
} from "../shared/racing/tracks/path";
import type { TelemetryPacket } from "../shared/telemetry/types";

function packet(
  overrides: Partial<TelemetryPacket> = {},
): TelemetryPacket {
  return {
    gameId: "fm-2023",
    TimestampMS: 0,
    PositionX: 0,
    PositionZ: 0,
    VelocityX: 0,
    VelocityZ: 0,
    Speed: 0,
    Yaw: 0,
    ...overrides,
  } as TelemetryPacket;
}

function semanticReader(
  values: ReadonlyMap<
    TelemetryPacket,
    Partial<Record<LapPathSemanticId, number>>
  >,
): LapPathSemanticReader {
  return {
    readNumber(source, semanticId) {
      return values.get(source)?.[semanticId];
    },
  };
}

describe("lap path", () => {
  test("preserves real world positions", () => {
    const packets = [
      packet({ PositionX: 12, PositionZ: -3 }),
      packet({ PositionX: 14, PositionZ: 5 }),
    ];

    expect(hasWorldPositions(packets)).toBe(true);
    expect(lapPath(packets)).toEqual({
      x: [12, 14],
      z: [-3, 5],
    });
    expect(
      lapPath(
        packets,
        undefined,
        semanticReader(new Map()),
      ),
    ).toEqual({
      x: [12, 14],
      z: [-3, 5],
    });
  });

  test("reads path positions through semantic IDs", () => {
    const packets = [
      packet({ PositionX: 0, PositionZ: 0 }),
      packet({ PositionX: 0, PositionZ: 0 }),
    ];
    const reader = semanticReader(
      new Map([
        [
          packets[0],
          { "motion.position-x": 12, "motion.position-z": -3 },
        ],
        [
          packets[1],
          { "motion.position-x": 14, "motion.position-z": 5 },
        ],
      ]),
    );

    expect(hasWorldPositions(packets, reader)).toBe(true);
    expect(lapPath(packets, undefined, reader)).toEqual({
      x: [12, 14],
      z: [-3, 5],
    });
  });

  test("integrates ordinary world-space velocity", () => {
    const packets = [
      packet(),
      packet({ TimestampMS: 500, VelocityX: 4, VelocityZ: -2 }),
      packet({ TimestampMS: 1000, VelocityX: 4, VelocityZ: -2 }),
    ];

    expect(integratePositions(packets)).toEqual({
      x: [0, 2, 4],
      z: [0, -1, -2],
    });
  });

  test("integrates semantic velocity before native fallback", () => {
    const packets = [
      packet(),
      packet({ TimestampMS: 500 }),
      packet({ TimestampMS: 1000 }),
    ];
    const reader = semanticReader(
      new Map([
        [
          packets[1],
          { "motion.velocity-x": 4, "motion.velocity-z": -2 },
        ],
        [
          packets[2],
          { "motion.velocity-x": 4, "motion.velocity-z": -2 },
        ],
      ]),
    );

    expect(integratePositions(packets, reader)).toEqual({
      x: [0, 2, 4],
      z: [0, -1, -2],
    });
  });

  test("reconstructs iRacing positions from heading and speed", () => {
    const packets = [
      packet({
        gameId: "iracing",
        Speed: 10,
        VelocityX: 100,
        Yaw: 0,
      }),
      packet({
        gameId: "iracing",
        TimestampMS: 1000,
        Speed: 10,
        VelocityX: 100,
        Yaw: 0,
      }),
      packet({
        gameId: "iracing",
        TimestampMS: 2000,
        Speed: 10,
        VelocityX: 100,
        Yaw: 0,
      }),
    ];

    expect(integratePositions(packets)).toEqual({
      x: [0, 0, 0],
      z: [0, 10, 20],
    });
  });

  test("projects iRacing lap fraction onto a compatible outline", () => {
    const packets = [
      packet({
        gameId: "iracing",
        iracing: { lapDistancePct: 0.25 } as TelemetryPacket["iracing"],
      }),
      packet({
        gameId: "iracing",
        TimestampMS: 1000,
        iracing: { lapDistancePct: 0.75 } as TelemetryPacket["iracing"],
      }),
    ];

    expect(
      lapPath(packets, [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 10 },
      ]),
    ).toEqual({
      x: [5, 10],
      z: [0, 5],
    });
  });

  test("projects semantic lap fraction when native extension is absent", () => {
    const packets = [
      packet({ gameId: "iracing" }),
      packet({ gameId: "iracing", TimestampMS: 1000 }),
    ];
    const reader = semanticReader(
      new Map([
        [packets[0], { "timing.lap-fraction": 0.25 }],
        [packets[1], { "timing.lap-fraction": 0.75 }],
      ]),
    );

    expect(
      lapPath(
        packets,
        [
          { x: 0, z: 0 },
          { x: 10, z: 0 },
          { x: 10, z: 10 },
        ],
        reader,
      ),
    ).toEqual({
      x: [5, 10],
      z: [0, 5],
    });
  });

  test("projects one live lap percentage by outline distance", () => {
    expect(
      pointAtLapFraction(
        [
          { x: 0, z: 0 },
          { x: 10, z: 0 },
          { x: 10, z: 10 },
        ],
        0.75,
      ),
    ).toEqual({ x: 10, z: 5 });
  });
});
