import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { initDb, db, client, DB_PATH } from "@raceiq/backend-core/db/index";
import { sessions, laps } from "@raceiq/backend-core/db/schema";
import { enqueueSessionCaptureSplit } from "@raceiq/backend-core/db/session-queries";
import { LAP_DETECTOR_ID } from "@raceiq/backend-core/lap-detection/detector";
import { encodeMetaFrame, encodeSparseCaptureFormatFrame, encodeFrameLength } from "@raceiq/capture-formats/session/framing";
import { DashboardAuth } from "../../../src/runtime/dashboard-auth";

await initDb();
try {
  const sourcePath = join(process.env.DATA_DIR!, "startup.bin");
  const auth = await DashboardAuth.create(client, DB_PATH);
  await auth.initialize(false);
  await auth.setup(null, true);
  const header = Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame()]);
  await writeFile(sourcePath, Buffer.concat([header, encodeFrameLength(4), Buffer.from([1, 2, 3, 4])]));
  const session = await db.insert(sessions).values({
    gameId: "fm-2023", carId: "test-car", trackId: "test-track", ownership: "mine",
    rawFile: sourcePath, captureFormatVersion: 1, lapDetectorVersion: LAP_DETECTOR_ID,
  }).returning({ id: sessions.id }).get();
  await db.insert(laps).values({
    sessionId: session.id, lapNumber: 1, lapTime: 60,
    rawByteOffset: header.length, rawFrameCount: 1,
  }).run();
  if (!await enqueueSessionCaptureSplit(session.id)) throw new Error("Failed to queue startup fixture");
} finally {
  client.close();
}
process.exit(0);
