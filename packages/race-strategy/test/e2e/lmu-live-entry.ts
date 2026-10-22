import { createInterface } from "node:readline";
import { bootServer } from "../../../../apps/backend/src/runtime/boot";
import { LMUTelemetrySource } from "@raceiq/game-lmu/source";
import { NativeLmuMemory, type NativeLmuInput } from "./lmu-live-source";

// Test composition replaces only the unavailable OS mapping. Parser, pipeline,
// persistence, HTTP, WebSocket, client and native context encoding are production code.
await bootServer();
const fixture = new NativeLmuMemory();
const source = new LMUTelemetrySource({
  reader: { start() {}, async stop() {}, readLatest: () => fixture.memory },
  rest: false,
});
// Runner owns this source; the OS process supervisor must not stop it on Windows.
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const command = JSON.parse(line) as { sequence: number; input: NativeLmuInput };
    await fixture.advance(command.input, () => source.pollOnce());
    console.log(`LMU_TEST_ACK:${command.sequence}`);
  } catch (error) {
    console.error("Native LMU fixture failed:", error);
    process.exit(1);
  }
}
await source.stop();
