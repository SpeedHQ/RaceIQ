import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../server/db";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { deleteSession, insertSession } from "../../server/db/session-queries";
import { sessions, laps } from "../../server/db/schema";
import { backfillLMUSessionIdentity } from "../../server/games/lmu/session-identity-backfill";
import {
  LMU_SCORING_INFO,
  LMU_SCORING_INFO_SIZE,
  LMU_TELEMETRY,
  LMU_TELEMETRY_INFO_SIZE,
} from "../../server/games/lmu/layout";
import { encodeLMUSourcePayload } from "../../server/games/lmu/source-frame";
import { encodeFrameLength, encodeMetaFrame } from "../../server/session-capture/framing";
import { RealDbAdapter } from "../../server/telemetry/pipeline-ports";

const sessionIds: number[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const id of sessionIds.splice(0)) await deleteSession(id);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeCString(buffer: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length - 1);
}

function canonicalCapture(): Buffer {
  const telemetry = Buffer.alloc(LMU_TELEMETRY_INFO_SIZE);
  const scoringInfo = Buffer.alloc(LMU_SCORING_INFO_SIZE);
  writeCString(telemetry, LMU_TELEMETRY.vehicleModel, 30, "Ferrari 499P");
  writeCString(telemetry, LMU_TELEMETRY.vehicleName, 64, "Ferrari AF Corse 2024 #50:LM");
  writeCString(telemetry, LMU_TELEMETRY.trackName, 64, "LeMansWEC");
  writeCString(scoringInfo, LMU_SCORING_INFO.trackName, 64, "Circuit de la Sarthe");
  const frame = encodeLMUSourcePayload({
    gameVersion: 1202,
    sessionEvent: 9,
    captureTimestampMs: 1_800_000_000_000,
    telemetry,
    scoringInfo,
    playerScoring: null,
  });
  return Buffer.concat([encodeMetaFrame(1), encodeFrameLength(frame.length), frame]);
}

test("LMU sessions write string identity while other games remain ordinal-only", async () => {
  const adapter = new RealDbAdapter({ notifyDriverProfile: false });
  const lmuId = await adapter.insertSession(
    "ferrari_499p_2023",
    "lemans_2023/lemanswec",
    "lmu",
    "race",
  );
  const forzaId = await adapter.insertSession("42", "99", "fm-2023");
  sessionIds.push(lmuId, forzaId);

  const rows = await db.select().from(sessions).where(eq(sessions.id, lmuId)).get();
  expect(rows).toMatchObject({
    carId: "ferrari_499p_2023",
    trackId: "lemans_2023/lemanswec",
  });
  const forza = await db.select().from(sessions).where(eq(sessions.id, forzaId)).get();
  expect(forza).toMatchObject({ carId: "42", trackId: "99" });
});

test("LMU identity backfill is idempotent and isolates missing or malformed captures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-lmu-backfill-"));
  directories.push(directory);
  const capturePath = join(directory, "valid.bin");
  const malformedPath = join(directory, "malformed.bin");
  const missingPath = join(directory, "missing.bin");
  const capture = canonicalCapture();
  await Bun.write(capturePath, capture);
  await Bun.write(malformedPath, Buffer.from("not a telemetry capture"));

  const validId = await insertSession("123456", "654321", "lmu");
  const malformedId = await insertSession("223456", "754321", "lmu");
  const missingId = await insertSession("323456", "854321", "lmu");
  const nativeId = await insertSession("423456", "954321", "lmu");
  sessionIds.push(validId, malformedId, missingId, nativeId);
  await db.update(sessions).set({ rawFile: capturePath }).where(eq(sessions.id, validId)).run();
  await db.update(sessions).set({ rawFile: malformedPath }).where(eq(sessions.id, malformedId)).run();
  await db.update(sessions).set({ rawFile: missingPath }).where(eq(sessions.id, missingId)).run();
  await db.update(sessions).set({
    rawFile: capturePath,
    carId: "native_car_key",
    trackId: "native_track_key",
  }).where(eq(sessions.id, nativeId)).run();
  const lapId = await insertLap(validId, 1, 90, true, 12, 1);

  const first = await backfillLMUSessionIdentity();
  const afterFirst = await db.select().from(sessions).where(eq(sessions.id, validId)).get();
  expect(afterFirst).toMatchObject({
    rawFile: capturePath,
    carId: "ferrari_499p_2023",
    trackId: "lemans_2023/lemanswec",
  });
  const nativeAfter = await db.select().from(sessions).where(eq(sessions.id, nativeId)).get();
  expect(nativeAfter).toMatchObject({ carId: "native_car_key", trackId: "native_track_key" });
  expect(first.malformedFile).toBeGreaterThanOrEqual(1);
  expect(first.missingFile).toBeGreaterThanOrEqual(1);
  expect(readFileSync(capturePath).equals(capture)).toBe(true);
  expect((await db.select().from(laps).where(eq(laps.id, lapId)).get())?.rawByteOffset).toBe(12);

  await backfillLMUSessionIdentity();
  const afterSecond = await db.select().from(sessions).where(eq(sessions.id, validId)).get();
  expect(afterSecond).toEqual(afterFirst);
});
