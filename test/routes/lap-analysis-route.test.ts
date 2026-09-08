import { describe, expect, test } from "bun:test";

import { initGameAdapters } from "../../shared/games/init";
import { getGame } from "../../shared/games/registry";
import { analyseSemanticIds } from "../../shared/games/metric-contracts";
import { decodeAlignedLapSet } from "../../shared/racing/laps/alignment/codec";
import type { EncodedAlignedLapSet } from "../../shared/racing/laps/alignment/types";

import { deleteSession, insertSession } from "../../server/db/session-queries";
import { cacheDelete, cacheSet } from "../../server/db/telemetry-replay-storage";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { lapRoutes } from "../../server/routes/laps";
import { semanticReplayIds } from "../../server/routes/laps/resource-routes";
import { packet } from "../support/telemetry/resolver";

initGameAdapters();

test("semantic replay requests F1 Analyse dependencies", () => {
  const ids = semanticReplayIds("f1-2025");
  expect(ids).toEqual(analyseSemanticIds(getGame("f1-2025")));
  expect(ids).toContain("timing.current-lap");
  expect(ids).toContain("timing.lap-fraction");
  expect(ids).not.toContain("tires.wheel-in-puddle-depth");
});

describe("GET /api/laps/:id/semantic-telemetry", () => {
  test("returns full F1 Analyse replay with adapter channels", async () => {
    const sessionId = await insertSession(1, 2, "f1-2025");
    const lapId = await insertLap(sessionId, 1, 80.9, true, null, 0);
    cacheSet(lapId, [
      packet("f1-2025", { TimestampMS: 1_000, Speed: 10 }),
      packet("f1-2025", { TimestampMS: 1_017, Speed: 20 }),
    ]);
    try {
      const response = await lapRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, {
        headers: { "X-Game-Id": "f1-2025" },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        lapId: number;
        requestedSemanticIds: readonly string[];
        envelopes: { sequence: number; values: { semanticId: string }[] }[];
        parseError: string | null;
      };
      expect(body.lapId).toBe(lapId);
      expect(body.parseError).toBeNull();
      expect(body.requestedSemanticIds).toEqual(analyseSemanticIds(getGame("f1-2025")));
      expect(body.envelopes).toHaveLength(2);
      expect(body.envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
      expect(body.envelopes[0]?.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ semanticId: "motion.speed", value: 10 })]),
      );
      expect(body.envelopes[1]?.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ semanticId: "motion.speed", value: 20 })]),
      );
    } finally {
      cacheDelete(lapId);
      await deleteSession(sessionId);
    }
  });
});

describe("GET /api/laps/review", () => {
  test("returns only top valid metadata laps for a track/car", async () => {
    const sessionId = await insertSession(10, 20, "acc");
    const lapIds = await Promise.all([61, 59, 62, 58, 60, 57].map((time, index) => insertLap(sessionId, index + 1, time, true, null, 0)));
    try {
      const response = await lapRoutes.request("/api/laps/review?gameId=acc&trackOrdinal=20&carOrdinal=10");
      expect(response.status).toBe(200);
      const body = await response.json() as { id: number; lapTime: number }[];
      expect(body).toHaveLength(5);
      expect(body.map((lap) => lap.lapTime)).toEqual([57, 58, 59, 60, 61]);
      expect(body.map((lap) => lap.id)).toEqual([lapIds[5], lapIds[3], lapIds[1], lapIds[4], lapIds[0]]);
    } finally {
      await deleteSession(sessionId);
    }
  });
});

describe("POST /api/laps/aligned-telemetry", () => {
  test("preserves requested order, wheel wear, sectors, and base cache identity", async () => {
    const sessionId = await insertSession(10, 20, "acc");
    const lapA = await insertLap(sessionId, 1, 61, true, null, 0, null, null, null, [20, 21, 20]);
    const lapB = await insertLap(sessionId, 2, 60, true, null, 0, null, null, null, [19, 21, 20]);
    const telemetry = (offset: number) => [0, 1, 2].map((distance, index) => packet("acc", {
      DistanceTraveled: distance,
      CurrentLap: index,
      TimestampMS: index * 1_000,
      PositionX: distance,
      PositionZ: distance,
      TireWearFL: offset + index / 10,
      TireWearFR: offset + index / 10 + 0.01,
      TireWearRL: offset + index / 10 + 0.02,
      TireWearRR: offset + index / 10 + 0.03,
    }));
    cacheSet(lapA, telemetry(0));
    cacheSet(lapB, telemetry(0.1));
    const request = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [lapB, lapA], step: 1 }) };
    try {
      const response = await lapRoutes.request("/api/laps/aligned-telemetry", request);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-RaceIQ-Cache")).toBe("MISS");
      const set = decodeAlignedLapSet((await response.json()) as EncodedAlignedLapSet);
      expect(set.laps.map((lap) => lap.lapId)).toEqual([lapB, lapA]);
      expect(set.laps[0]!.sectorTimes).toEqual([19, 21, 20]);
      expect(set.laps[0]!.tireWear).not.toBeNull();
      expect(set.laps[0]!.tireWear!.RR.length).toBe(set.distanceMeters.length);

      const repeated = await lapRoutes.request("/api/laps/aligned-telemetry", request);
      expect(repeated.status).toBe(200);
      expect(repeated.headers.get("X-RaceIQ-Cache")).toBe("HIT");
    } finally {
      cacheDelete(lapA);
      cacheDelete(lapB);
      await deleteSession(sessionId);
    }
  });
});

  test("rejects malformed and missing alignment requests and returns empty spread", async () => {
    const malformed = await lapRoutes.request("/api/laps/aligned-telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [], step: 1 }),
    });
    expect(malformed.status).toBe(400);

    const missing = await lapRoutes.request("/api/laps/aligned-telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [999999], step: 1 }),
    });
    expect(missing.status).toBe(404);

    const emptyReview = await lapRoutes.request("/api/laps/review-line-spread?gameId=acc&sessionId=999999");
    expect(emptyReview.status).toBe(200);
    expect(await emptyReview.json()).toMatchObject({ lapCount: 0, spreadM: [] });
  });

describe("POST /api/laps/:id/analyse", () => {
  test("keeps missing-lap HTTP error before regenerate stream", async () => {
    const response = await lapRoutes.request(
      "/api/laps/999999/analyse?regenerate=true",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Lap not found" });
  });
});

describe("DELETE /api/laps/:id/analyse", () => {
  test("clears only the lap analysis record", async () => {
    const response = await lapRoutes.request("/api/laps/999999/analyse", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("GET /api/laps/:id/analyse/status", () => {
  test("reports no active run for idle lap", async () => {
    const response = await lapRoutes.request("/api/laps/999999/analyse/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "none" });
  });
});

describe("GET /api/laps/:id1/compare/:id2/inputs-analyse/status", () => {
  test("reports no active run for idle comparison", async () => {
    const response = await lapRoutes.request(
      "/api/laps/1/compare/2/inputs-analyse/status",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "none" });
  });
});
