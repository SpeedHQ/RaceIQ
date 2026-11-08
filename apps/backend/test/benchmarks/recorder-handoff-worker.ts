import { parentPort } from "node:worker_threads";
import "@raceiq/capture-formats/session/source-writer-worker";

if (!parentPort) throw new Error("Handoff probe requires a worker thread");
const port = parentPort;
// Observe receipt in the same message turn, before queued filesystem work runs.
// One reply per batch avoids adding a per-record RPC to production transport.
port.on("message", (message: { type: string; records?: { sequence: number; bytes: Uint8Array; sourceEvent: { bytes: Uint8Array } }[] }) => {
  if (message.type !== "batch" || !message.records?.length) return;
  const receivedNs = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  let transferredBytes = 0;
  for (const record of message.records) transferredBytes += record.bytes.byteLength + record.sourceEvent.bytes.byteLength;
  port.postMessage({
    type: "benchmark-received", receivedNs,
    firstSequence: message.records[0]!.sequence,
    lastSequence: message.records.at(-1)!.sequence,
    records: message.records.length, transferredBytes,
  });
});
