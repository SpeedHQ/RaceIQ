import { describe, expect, test } from "bun:test";
import { initServerGameAdapters } from "../../server/games/init";
import { importSessionBin } from "../../server/session-capture/import-capture";
import { META_FRAME_MAGIC } from "../../server/session-capture/framing";
import { importErrorPayload, IncompleteImportError, InvalidImportDataError } from "../../server/session-capture/import-pipeline";
import { initGameAdapters } from "../../shared/games/init";

initGameAdapters();
initServerGameAdapters();

describe("telemetry import quality errors", () => {
  test("serializes corrupt and incomplete imports with machine-readable quality reasons", () => {
    expect(importErrorPayload(new InvalidImportDataError())).toEqual({
      error: "Import contains unusable telemetry data",
      code: "INVALID_IMPORT_DATA",
      quality: { lifecycleState: "corrupt", reasons: ["recording_corrupt"] },
    });
    expect(importErrorPayload(new IncompleteImportError())).toEqual({
      error: "No complete, importable laps were found",
      code: "INCOMPLETE_IMPORT",
      quality: { lifecycleState: "incomplete", reasons: ["recording_incomplete"] },
    });
  });

  test("rejects truncated framing as corrupt instead of reporting no laps", async () => {
    const truncated = Buffer.alloc(6);
    truncated.writeUInt32LE(10, 0);
    truncated.writeUInt8(0xaa, 4);
    truncated.writeUInt8(0xbb, 5);

    await expect(importSessionBin(truncated, "acc", { requireLaps: true })).rejects.toMatchObject({
      code: "INVALID_IMPORT_DATA",
      lifecycleState: "corrupt",
      reasons: ["recording_corrupt"],
    });
  });

  test("reports a readable complete stream with no detected laps as incomplete", async () => {
    const empty = Buffer.alloc(8);
    empty.writeUInt32LE(META_FRAME_MAGIC, 0);
    empty.writeUInt32LE(0, 4);

    await expect(importSessionBin(empty, "acc", { requireLaps: true })).rejects.toMatchObject({
      code: "INCOMPLETE_IMPORT",
      lifecycleState: "incomplete",
      reasons: ["recording_incomplete"],
    });
  });
});
