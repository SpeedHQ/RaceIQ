import { expect, test } from "bun:test";
import { OpponentPaceTracker } from "@raceiq/live-engineer/opponent-pace-tracker";
const fact = (id: string, lap: number, time: number) => ({ factId: id, gameId: "f1-2025", sessionId: "s", timelineEpoch: 1, participantId: "o", participantName: "Opponent", classId: "overall", lapNumber: lap, lapTimeMs: time, valid: true as const, inPit: false, completedSessionTimeMs: lap * 60_000, sourceSequence: lap, sourceQuality: "native-validity" as const });
test("deduplicates facts and classifies completed player lap", () => { const tracker = new OpponentPaceTracker(); tracker.reset(1); expect(tracker.addFact(fact("a", 1, 60_000))).toBe(true); expect(tracker.addFact(fact("a", 1, 60_000))).toBe(false); expect(tracker.createCandidate({ sessionId: "s", timelineEpoch: 1, lapNumber: 1, lapTimeMs: 60_120, classId: "overall", sessionType: "practice", completedSessionTimeMs: 61_000, sourceSequence: 2 })?.relation).toBe("within-class-pace"); });

test("beating recent race pace does not imply a class-best lap", () => {
  const tracker = new OpponentPaceTracker();
  tracker.reset(1);
  [90_000, 100_000, 100_000].forEach((time, index) => tracker.addFact(fact(String(index), index + 1, time)));
  const lap = { sessionId: "s", timelineEpoch: 1, lapNumber: 4, lapTimeMs: 99_000, classId: "overall", sessionType: "race", completedSessionTimeMs: 400_000, sourceSequence: 4 };
  expect(tracker.createCandidate(lap)?.relation).toBe("setting-race-pace");
  expect(tracker.createCandidate({ ...lap, lapTimeMs: 89_000 })).toMatchObject({ relation: "fastest-in-class", deltaMs: -1000, benchmarkLapTimeMs: 90_000 });
});
