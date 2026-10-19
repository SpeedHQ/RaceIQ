import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearRetiredOutboxPayloads, enqueueOutboxJob, getOutboxJob, listDeliverableOutboxJobs, listRetiredOutboxPayloads, persistOutboxPayload, withdrawAccountOutboxJobs } from "../src/outbox-storage";
import { cleanupRetiredOnlinePayloads } from "../src/upload-dispatch";

const root = join(process.env.DATA_DIR!, "online-upload-payloads");
const original = join(root, "recording-original.bin");
const originalSetup = join(root, "setup-original.bin");
const replacement = join(root, "recording-replacement.bin");
const replacementSetup = join(root, "setup-replacement.bin");
const accountId = "replacement-account";

if (process.argv[2] === "prepare") {
  await mkdir(root, { recursive: true });
  await writeFile(original, "original-recording");
  await writeFile(originalSetup, "original-setup");
  const identity = { accountId, accountEpoch: "replacement-epoch", gameId: "acc", trackId: "replacement-track", carId: "car", lapId: 1, lapTimeMs: 90_000 };
  assert.equal(await enqueueOutboxJob(identity), "queued");
  const [job] = await listDeliverableOutboxJobs(accountId);
  assert.ok(job);
  const stored = await persistOutboxPayload(job, { fingerprint: "original", recordingPath: original, setupPath: originalSetup });
  assert.ok(stored);
  await writeFile(replacement, "replacement-recording");
  await writeFile(replacementSetup, "replacement-setup");
  const middle = await persistOutboxPayload(stored, { fingerprint: "middle", recordingPath: replacement, setupPath: replacementSetup });
  assert.ok(middle);
  const updated = await persistOutboxPayload(middle, { fingerprint: "replacement", recordingPath: original, setupPath: replacementSetup });
  process.stdout.write("replacement-persisted\n");
} else {
  const retired = await listRetiredOutboxPayloads();
  assert.equal(retired.length, 2);
  assert.ok(retired.every((entry) => entry.retiredId !== null && entry.retiredId > 0));
  assert.deepEqual(retired.map(({ recordingPath, setupPath }) => ({ recordingPath, setupPath })),
    [{ recordingPath: original, setupPath: originalSetup }, { recordingPath: replacement, setupPath: null }]);
  assert.equal(await readFile(original, "utf8"), "original-recording");
  assert.equal(await readFile(originalSetup, "utf8"), "original-setup");
  const current = await getOutboxJob(1, accountId);
  assert.equal(current?.recordingPath, original);
  assert.equal(current?.setupPath, replacementSetup);
  assert.equal(await readFile(current!.recordingPath!, "utf8"), "original-recording");
  assert.equal(await readFile(current!.setupPath!, "utf8"), "replacement-setup");
  await cleanupRetiredOnlinePayloads();
  await assert.rejects(readFile(originalSetup));
  await assert.rejects(readFile(replacement));
  assert.equal(await readFile(original, "utf8"), "original-recording");
  assert.equal(await readFile(replacementSetup, "utf8"), "replacement-setup");
  assert.deepEqual(await listRetiredOutboxPayloads(), []);
  await cleanupRetiredOnlinePayloads();
  assert.equal(await readFile(original, "utf8"), "original-recording");
  assert.equal(await readFile(replacementSetup, "utf8"), "replacement-setup");
  let batchJob = current!;
  for (let index = 0; index < 3; index++) {
    const next = await persistOutboxPayload(batchJob, {
      fingerprint: `batch-${index}`, recordingPath: join(root, `batch-${index}.bin`), setupPath: null,
    });
    assert.ok(next);
    batchJob = next;
  }
  const firstBatch = await listRetiredOutboxPayloads(1);
  assert.equal(firstBatch.length, 1);
  await clearRetiredOutboxPayloads(firstBatch[0]!);
  assert.equal((await listRetiredOutboxPayloads()).length, 2);
  const terminalRecording = join(root, "terminal-recording.bin");
  const terminalSetup = join(root, "terminal-setup.bin");
  await writeFile(terminalRecording, "terminal-recording");
  await writeFile(terminalSetup, "terminal-setup");
  const terminalAccount = "terminal-account";
  assert.equal(await enqueueOutboxJob({
    accountId: terminalAccount, accountEpoch: "terminal-epoch", gameId: "acc", trackId: "terminal-track",
    carId: "car", lapId: 2, lapTimeMs: 91_000,
  }), "queued");
  const [terminalJob] = await listDeliverableOutboxJobs(terminalAccount);
  assert.ok(terminalJob);
  assert.ok(await persistOutboxPayload(terminalJob, {
    fingerprint: "terminal", recordingPath: terminalRecording, setupPath: terminalSetup,
  }));
  await withdrawAccountOutboxJobs(terminalAccount);
  await cleanupRetiredOnlinePayloads();
  await assert.rejects(readFile(terminalRecording));
  await assert.rejects(readFile(terminalSetup));
}
