import { expect, test } from "bun:test";
import { accBroadcastingFact, decodeAccBroadcastingLap } from "../../../server/games/acc/broadcasting";
test("ACC rejects invalid laps and normalizes class", () => { const info = decodeAccBroadcastingLap(JSON.stringify({ carIndex: 2, driverName: "Opponent", carModel: "GT3", cupCategory: "GT3", lapNumber: 4, lapTimeMs: 61_000, sessionTimeMs: 240_000, eventIndex: 4 })); expect(info).not.toBeNull(); expect(accBroadcastingFact(info!, "s", 1, 9)?.classId).toBe("gt3"); expect(accBroadcastingFact({ ...info!, isInvalid: true }, "s", 1, 9)).toBeNull(); });
