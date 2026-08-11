import { expect, test } from "@playwright/test";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { RecordingFilesSchema } from "./helpers";

test("developer recording APIs isolate empty artifacts and report invalid recordings", async ({ request }, testInfo) => {
  const recordingName = `fm-2023-e2e-empty-${testInfo.workerIndex}-${Date.now()}`;
  const artifactPath = resolve(__dirname, "../../../../test/artifacts/sessions", `${recordingName}.bin`);
  await writeFile(artifactPath, Buffer.alloc(0));

  try {
    const filesResponse = await request.get("/api/dev/e2e-files");
    expect(filesResponse.ok()).toBe(true);
    const files = RecordingFilesSchema.parse(await filesResponse.json()).files;
    expect(files.some((file) => file.name === recordingName)).toBe(true);

    const packetResponse = await request.get(`/api/dev/e2e-packets/${encodeURIComponent(recordingName)}`);
    expect(packetResponse.ok()).toBe(true);
    expect(await packetResponse.json()).toEqual({ packetCount: 0, packets: [] });

    const lapsResponse = await request.get(`/api/dev/e2e-laps/${encodeURIComponent(recordingName)}`);
    expect(lapsResponse.ok()).toBe(true);
    expect(await lapsResponse.json()).toEqual({ laps: [], totalPackets: 0 });

    const svgResponse = await request.get(`/api/dev/e2e-svg/${encodeURIComponent(recordingName)}`);
    expect(svgResponse.status()).toBe(400);
    expect(await svgResponse.json()).toMatchObject({
      error: "Failed to parse any packets from recording",
    });

    const missingResponse = await request.get("/api/dev/e2e-packets/fm-2023-does-not-exist");
    expect(missingResponse.status()).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: "Recording not found" });
  } finally {
    await unlink(artifactPath);
  }

  const filesAfterCleanup = RecordingFilesSchema.parse(await (await request.get("/api/dev/e2e-files")).json()).files;
  expect(filesAfterCleanup.some((file) => file.name === recordingName)).toBe(false);
});
