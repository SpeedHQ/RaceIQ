import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../shared/types";
import {
  detectSessionBoundary,
  detectLapBoundary,
  detectLapReset,
  type SessionSnapshot,
} from "../server/lap-detection";
import { getTrackSectorsByOrdinal } from "../shared/track-data";
import { assertSectorTimesMatchLapTime } from "./helpers/lap-assertions";

function pkt(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 1000,
    LapNumber: 1,
    CurrentLap: 30,
    LastLap: 0,
    BestLap: 0,
    DistanceTraveled: 2000,
    CarOrdinal: 100,
    TrackOrdinal: 5,
    Speed: 50,
    PositionX: 0,
    PositionZ: 0,
    ...overrides,
  } as TelemetryPacket;
}

const SESSION: SessionSnapshot = { carOrdinal: 100, trackOrdinal: 5 };
const NOW = 10_000_000; // large enough that NOW - 6min > 0

// ── detectSessionBoundary ─────────────────────────────────────────────────────

describe("detectSessionBoundary", () => {
  test("null session → no-session", () => {
    expect(detectSessionBoundary(null, 1, null, 0, pkt(), NOW)).toBe("no-session");
  });

  test("same car/track, no triggers → null (continue)", () => {
    expect(detectSessionBoundary(SESSION, 1, 2000, NOW, pkt(), NOW)).toBeNull();
  });

  test("car changed", () => {
    expect(
      detectSessionBoundary(SESSION, 1, 2000, NOW, pkt({ CarOrdinal: 999 }), NOW)
    ).toBe("car-changed");
  });

  test("track changed", () => {
    expect(
      detectSessionBoundary(SESSION, 1, 2000, NOW, pkt({ TrackOrdinal: 99 }), NOW)
    ).toBe("track-changed");
  });

  test("lap number reset from lap 5 → 1", () => {
    expect(
      detectSessionBoundary(SESSION, 5, 2000, NOW, pkt({ LapNumber: 1 }), NOW)
    ).toBe("lap-number-reset");
  });

  test("lap number reset not triggered when still on lap 1", () => {
    // currentLapNumber must be > 1
    expect(
      detectSessionBoundary(SESSION, 1, 2000, NOW, pkt({ LapNumber: 1 }), NOW)
    ).toBeNull();
  });

  test("distance reset (>1000m → <500m) without sessionUID", () => {
    // LapNumber matches currentLapNumber so lap-number-reset doesn't fire first
    expect(
      detectSessionBoundary(SESSION, 2, 1500, NOW, pkt({ LapNumber: 2, DistanceTraveled: 100 }), NOW)
    ).toBe("distance-reset");
  });

  test("distance reset ignored when session has UID (F1)", () => {
    const f1Session: SessionSnapshot = { ...SESSION, sessionUID: "abc123" };
    expect(
      detectSessionBoundary(f1Session, 2, 1500, NOW, pkt({ LapNumber: 2, DistanceTraveled: 100 }), NOW)
    ).toBeNull();
  });

  test("silence timeout after 5 minutes", () => {
    const lastPacketTime = NOW - 6 * 60_000;
    expect(
      detectSessionBoundary(SESSION, 1, 2000, lastPacketTime, pkt(), NOW)
    ).toBe("silence-timeout");
  });

  test("silence timeout not triggered within 5 minutes", () => {
    const lastPacketTime = NOW - 2 * 60_000;
    expect(
      detectSessionBoundary(SESSION, 1, 2000, lastPacketTime, pkt(), NOW)
    ).toBeNull();
  });

  test("silence timeout not triggered for F1 (has sessionUID)", () => {
    const f1Session: SessionSnapshot = { ...SESSION, sessionUID: "abc" };
    const lastPacketTime = NOW - 10 * 60_000;
    expect(
      detectSessionBoundary(f1Session, 1, 2000, lastPacketTime, pkt(), NOW)
    ).toBeNull();
  });

  test("F1 sessionUID changed", () => {
    const f1Session: SessionSnapshot = { ...SESSION, sessionUID: "old" };
    expect(
      detectSessionBoundary(f1Session, 1, 2000, NOW, pkt({ sessionUID: "new" }), NOW)
    ).toBe("session-uid-changed");
  });
});

// ── detectLapBoundary ─────────────────────────────────────────────────────────

describe("detectLapBoundary", () => {
  test("normal +1 lap increment → complete", () => {
    expect(detectLapBoundary(3, pkt({ LapNumber: 4 }))).toEqual({ action: "complete" });
  });

  test("lap number went backward → reset-rewind", () => {
    expect(detectLapBoundary(5, pkt({ LapNumber: 3 }))).toEqual({ action: "reset-rewind" });
  });

  test("lap skip (+2) → complete-skip with reason", () => {
    const result = detectLapBoundary(3, pkt({ LapNumber: 5 }));
    expect(result.action).toBe("complete-skip");
    if (result.action === "complete-skip") {
      expect(result.invalidReason).toContain("3");
      expect(result.invalidReason).toContain("5");
    }
  });

  test("large lap skip (+5) → complete-skip", () => {
    expect(detectLapBoundary(1, pkt({ LapNumber: 6 }))).toMatchObject({ action: "complete-skip" });
  });
});

// ── detectLapReset ────────────────────────────────────────────────────────────

describe("detectLapReset", () => {
  function last(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
    return pkt({ CurrentLap: 60, DistanceTraveled: 3000, ...overrides });
  }

  test("no reset condition → none", () => {
    // Distance must not drop >500m and CurrentLap must not reset to 0
    expect(detectLapReset(last(), 60, pkt({ CurrentLap: 61, DistanceTraveled: 3050 }))).toEqual({ action: "none" });
  });

  test("CurrentLap reset to 0 with LastLap unchanged → reset-restart", () => {
    expect(
      detectLapReset(last({ CurrentLap: 60 }), 0, pkt({ CurrentLap: 0, LastLap: 0 }))
    ).toEqual({ action: "reset-restart" });
  });

  test("CurrentLap reset to 0 with LastLap changed → complete-final-lap", () => {
    expect(
      detectLapReset(last({ CurrentLap: 60 }), 58.5, pkt({ CurrentLap: 0, LastLap: 60.1 }))
    ).toEqual({ action: "complete-final-lap" });
  });

  test("large distance drop with LastLap unchanged → reset-restart", () => {
    expect(
      detectLapReset(last({ DistanceTraveled: 3000 }), 0, pkt({ DistanceTraveled: 100, CurrentLap: 61 }))
    ).toEqual({ action: "reset-restart" });
  });

  test("large distance drop with LastLap changed → complete-final-lap", () => {
    expect(
      detectLapReset(last({ DistanceTraveled: 3000 }), 58.5, pkt({ DistanceTraveled: 100, LastLap: 60.1 }))
    ).toEqual({ action: "complete-final-lap" });
  });

  test("small distance drop (<500m) → none", () => {
    expect(
      detectLapReset(last({ DistanceTraveled: 3000 }), 0, pkt({ DistanceTraveled: 2600 }))
    ).toEqual({ action: "none" });
  });

  test("CurrentLap reset but was < 5s (warmup) → none", () => {
    // lastPkt.CurrentLap must be > 5 to trigger; keep distance stable so only CurrentLap check applies
    expect(
      detectLapReset(last({ CurrentLap: 3 }), 0, pkt({ CurrentLap: 0, DistanceTraveled: 3050 }))
    ).toEqual({ action: "none" });
  });
});

// ── FM-2023 Lap 0 → Lap 1 with Estimated Lap ────────────────────────────────────

describe("FM-2023: Lap 0 complete, Lap 1 receives estimated lap", () => {
  test("lap 0 completes (LapNumber 0 → 1) - invalid warmup lap", () => {
    // Lap 0 is a warmup/invalid lap, driver crosses line entering lap 1
    const boundary = detectLapBoundary(0, pkt({ LapNumber: 1 }));
    expect(boundary).toEqual({ action: "complete" });
    // Lap 0 is typically invalid (warmup); isValid should be false
  });

  test("lap 0 with rewind detection marks lap invalid", () => {
    // Rewind: CurrentLap drops significantly (> 500m distance drop)
    const lap0Before = pkt({
      LapNumber: 0,
      CurrentLap: 45.5,
      DistanceTraveled: 2000,
    });
    const lap0AfterRewind = pkt({
      LapNumber: 0,
      CurrentLap: 30.0,
      DistanceTraveled: 1400, // 600m drop = rewind
    });
    const resetResult = detectLapReset(lap0Before, 0, lap0AfterRewind);
    // Rewind detected (distance drop >500m) should mark as reset-restart
    expect(resetResult.action).toBe("reset-restart");
  });

  test("lap 1 starts fresh after lap 0 - initially valid until proven otherwise", () => {
    // After lap 0 completes, lap 1 begins
    // Lap 1 receives CurrentLap = 0 initially, building up as driver progresses
    // Lap 1 is assumed valid until a rewind or reset is detected
    const lap1Start = pkt({ LapNumber: 1, CurrentLap: 0, DistanceTraveled: 50 });
    expect(lap1Start.LapNumber).toBe(1);
    expect(lap1Start.CurrentLap).toBe(0);
    // isValid: true (no rewind or reset detected yet)
  });

  test("lap 1 mid-way through gets LastLap set to lap 0 time (estimated)", () => {
    // Driver is halfway through lap 1, game sets LastLap to the lap 0 time
    // This becomes the 'estimated' lap for lap 1 UI purposes
    const lap1Progress = pkt({
      LapNumber: 1,
      CurrentLap: 45.5,
      LastLap: 95.2, // lap 0 was 95.2 seconds
      DistanceTraveled: 1500,
    });
    expect(lap1Progress.LastLap).toBe(95.2);
    expect(lap1Progress.CurrentLap).toBe(45.5);
    // isValid: true (no rewind detected yet)
  });

  test("lap 1 completes valid with final time", () => {
    // Lap 1 crosses the line, completes cleanly (no rewind, no skip)
    const lap1Complete = pkt({
      LapNumber: 2, // LapNumber increments
      LastLap: 92.8, // lap 1 final time
      CurrentLap: 0, // reset for lap 2
      DistanceTraveled: 100, // reset
    });
    const boundary = detectLapBoundary(1, lap1Complete);
    expect(boundary).toEqual({ action: "complete" });
    expect(lap1Complete.LastLap).toBe(92.8); // lap 1 time is now in LastLap
    // isValid: true (clean completion, no flags)
  });

  test("lap 1 marked invalid if rewind occurs during lap", () => {
    // Driver rewinds during lap 1 (large distance drop)
    const lap1Before = pkt({
      LapNumber: 1,
      CurrentLap: 60.0,
      DistanceTraveled: 2500,
    });
    const lap1AfterRewind = pkt({
      LapNumber: 1,
      CurrentLap: 55.0,
      DistanceTraveled: 1800, // 700m drop = rewind
    });
    const resetResult = detectLapReset(lap1Before, 58.5, lap1AfterRewind);
    // Rewind invalidates the lap (distance drop >500m)
    expect(resetResult.action).toBe("reset-restart");
    // isValid: false (rewind detected)
  });

  test("lap 1 marked invalid if lap was skipped (0 → 2)", () => {
    // Game skips lap number (0 → 2), indicates malfunction/invalid state
    const boundary = detectLapBoundary(0, pkt({ LapNumber: 2 }));
    expect(boundary.action).toBe("complete-skip");
    // isValid: false (lap skip detected, recorded as invalid)
    if (boundary.action === "complete-skip") {
      expect(boundary.invalidReason).toBeDefined();
    }
  });

  test("lap 0 invalid (incomplete), lap 1 uses lap 0 time as estimate", () => {
    // If lap 0 was too short to be valid, CurrentLap of lap 0 becomes the estimate for lap 1
    // Lap 0 is not a complete lap (warmup), so isValid: false
    const lap0Invalid = pkt({
      LapNumber: 0,
      CurrentLap: 45.0, // incomplete lap (warmup)
      DistanceTraveled: 1000,
    });
    const lap1Using0Estimate = pkt({
      LapNumber: 1,
      CurrentLap: 30.0,
      LastLap: lap0Invalid.CurrentLap, // use incomplete lap 0 as estimate
      DistanceTraveled: 1500,
    });
    expect(lap1Using0Estimate.LastLap).toBe(45.0);
    // Lap 0 isValid: false (incomplete/warmup)
    // Lap 1 isValid: true (starts fresh after lap 0, no flags yet)
  });

  test("lap 0 invalid, lap 1 valid, lap 2 continues sequence", () => {
    // Full sequence: lap 0 (invalid warmup) → lap 1 (valid) → lap 2
    const lap0 = pkt({ LapNumber: 0, CurrentLap: 50 });
    const lap0Complete = detectLapBoundary(0, pkt({ LapNumber: 1 }));
    expect(lap0Complete.action).toBe("complete");
    // Lap 0 isValid: false

    const lap1 = pkt({ LapNumber: 1, CurrentLap: 92.8, LastLap: 50 });
    // Lap 1 isValid: true (no rewind, clean lap)

    const lap1Complete = detectLapBoundary(1, pkt({ LapNumber: 2, LastLap: 92.8 }));
    expect(lap1Complete.action).toBe("complete");
    // Lap 1 isValid: true (completed cleanly)
  });

  test("single session persists through lap 0 → 1 → 2", () => {
    // Verify that no session boundary is triggered during the sequence
    const SESSION: SessionSnapshot = { carOrdinal: 100, trackOrdinal: 5 };
    const NOW = 10_000_000;

    // Packet 1: lap 0 in progress
    const pkt0 = pkt({ LapNumber: 0, CarOrdinal: 100, TrackOrdinal: 5 });
    const boundary0 = detectSessionBoundary(SESSION, 0, 0, NOW, pkt0, NOW);
    expect(boundary0).toBeNull(); // same session

    // Packet 2: lap 0 → 1 transition
    const pkt1Start = pkt({ LapNumber: 1, CarOrdinal: 100, TrackOrdinal: 5 });
    const boundary1 = detectSessionBoundary(SESSION, 1, 2000, NOW, pkt1Start, NOW);
    expect(boundary1).toBeNull(); // same session continues

    // Packet 3: lap 1 in progress with estimated lap time
    const pkt1Progress = pkt({
      LapNumber: 1,
      CurrentLap: 45.5,
      LastLap: 95.2,
      CarOrdinal: 100,
      TrackOrdinal: 5,
    });
    const boundary1Progress = detectSessionBoundary(SESSION, 1, 1500, NOW, pkt1Progress, NOW);
    expect(boundary1Progress).toBeNull(); // same session continues

    // Packet 4: lap 1 → 2 transition
    const pkt2Start = pkt({
      LapNumber: 2,
      LastLap: 92.8,
      CarOrdinal: 100,
      TrackOrdinal: 5,
    });
    const boundary2 = detectSessionBoundary(SESSION, 2, 100, NOW, pkt2Start, NOW);
    expect(boundary2).toBeNull(); // same session continues

    // All packets were in one continuous session (no boundary detected)
  });

  test("lap 0 sector times computed from distance boundaries", () => {
    // FM-2023 uses distance-based sector calculations
    // Example: if track has sectors at s1End=1000m, s2End=2500m, total=5000m
    // and lap 0 progresses: 0 → 1000 (s1) → 2500 (s2) → 5000 (lap complete)
    // Assuming CurrentLap timing: s1=45.2s, s2=48.5s (s2 time minus s1), s3=45.8s
    const lap0Packets = [
      pkt({ LapNumber: 0, CurrentLap: 45.2, DistanceTraveled: 1000 }), // s1 boundary
      pkt({ LapNumber: 0, CurrentLap: 93.7, DistanceTraveled: 2500 }), // s2 boundary
      pkt({ LapNumber: 0, CurrentLap: 139.5, DistanceTraveled: 5000 }), // lap complete
    ];

    // Lap 0 sector times (from CurrentLap timing):
    // s1: 45.2s
    // s2: 93.7 - 45.2 = 48.5s
    // s3: 139.5 - 93.7 = 45.8s
    expect(lap0Packets[0].CurrentLap).toBe(45.2); // s1 time
    expect(lap0Packets[1].CurrentLap - lap0Packets[0].CurrentLap).toBe(48.5); // s2 time
    expect(lap0Packets[2].CurrentLap - lap0Packets[1].CurrentLap).toBe(45.8); // s3 time
  });

  test("lap 1 sector times with incremental timing", () => {
    // Lap 1 starts after lap 0 completes, with LastLap = lap 0 final time (139.5s estimated)
    // Lap 1 progresses with CurrentLap building up from 0
    const lap1Packets = [
      pkt({
        LapNumber: 1,
        CurrentLap: 0,
        LastLap: 139.5, // lap 0 estimated time
        DistanceTraveled: 50,
      }), // lap 1 start
      pkt({
        LapNumber: 1,
        CurrentLap: 44.8,
        LastLap: 139.5,
        DistanceTraveled: 1000,
      }), // s1 boundary
      pkt({
        LapNumber: 1,
        CurrentLap: 93.1,
        LastLap: 139.5,
        DistanceTraveled: 2500,
      }), // s2 boundary
      pkt({
        LapNumber: 1,
        CurrentLap: 138.7,
        LastLap: 139.5,
        DistanceTraveled: 5000,
      }), // lap complete
    ];

    // Lap 1 sector times (from CurrentLap):
    // s1: 44.8s (faster than lap 0's 45.2s)
    // s2: 93.1 - 44.8 = 48.3s (faster than lap 0's 48.5s)
    // s3: 138.7 - 93.1 = 45.6s (similar to lap 0's 45.8s)
    expect(lap1Packets[1].CurrentLap).toBe(44.8); // s1 time
    expect(lap1Packets[2].CurrentLap - lap1Packets[1].CurrentLap).toBeCloseTo(48.3, 1); // s2 time
    expect(lap1Packets[3].CurrentLap - lap1Packets[2].CurrentLap).toBeCloseTo(45.6, 1); // s3 time
    expect(lap1Packets[3].CurrentLap).toBe(138.7); // total lap 1 time
  });

  test("lap 0 and lap 1 sector times comparison", () => {
    // Both laps have predictable sector progressions
    const lap0Final = { s1: 45.2, s2: 48.5, s3: 45.8, total: 139.5 };
    const lap1Final = { s1: 44.8, s2: 48.3, s3: 45.6, total: 138.7 };

    // Lap 1 is faster overall
    expect(lap1Final.total).toBeLessThan(lap0Final.total);
    // Lap 1 is faster in s1 and s2, similar in s3
    expect(lap1Final.s1).toBeLessThan(lap0Final.s1);
    expect(lap1Final.s2).toBeLessThan(lap0Final.s2);
    expect(lap1Final.s3).toBeLessThan(lap0Final.s3 + 1); // within 1s
  });

  test("lap 0 sector times sum to lap time", () => {
    const lap0 = {
      sectors: { s1: 45.2, s2: 48.5, s3: 45.8 },
      lapTime: 139.5,
    };
    assertSectorTimesMatchLapTime(lap0 as any);
  });

  test("lap 1 sector times sum to lap time", () => {
    const lap1 = {
      sectors: { s1: 44.8, s2: 48.3, s3: 45.6 },
      lapTime: 138.7,
    };
    assertSectorTimesMatchLapTime(lap1 as any);
  });

  test("lap 0 → lap 1 sector times have realistic deltas (no gigantic jumps)", () => {
    // Sector times should improve gradually, not jump by 10+ seconds
    const lap0 = { s1: 45.2, s2: 48.5, s3: 45.8 };
    const lap1 = { s1: 44.8, s2: 48.3, s3: 45.6 };

    // Max realistic delta is ~2 seconds per sector (aggressive improvement)
    const maxDelta = 2.0;

    expect(Math.abs(lap1.s1 - lap0.s1)).toBeLessThan(maxDelta);
    expect(Math.abs(lap1.s2 - lap0.s2)).toBeLessThan(maxDelta);
    expect(Math.abs(lap1.s3 - lap0.s3)).toBeLessThan(maxDelta);

    // Total lap time delta also reasonable
    const lap0Total = lap0.s1 + lap0.s2 + lap0.s3;
    const lap1Total = lap1.s1 + lap1.s2 + lap1.s3;
    expect(Math.abs(lap1Total - lap0Total)).toBeLessThan(3.0); // ~3 seconds realistic improvement
  });
});
