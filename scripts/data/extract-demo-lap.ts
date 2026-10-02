/**
 * Extract lap 1337 telemetry to a static CSV file for the onboarding welcome screen.
 * Run: bun run scripts/data/extract-demo-lap.ts
 */
import { resolve } from "node:path";
import { getLapById } from "../../server/db/lap-read-queries";

const DEMO_LAP_ID = 1337;
const lap = await getLapById(DEMO_LAP_ID);
if (!lap) {
  console.error(`Lap ${DEMO_LAP_ID} not found`);
  process.exit(1);
}
if (lap.telemetry.length === 0) {
  console.error(`Lap ${DEMO_LAP_ID} has no telemetry`);
  process.exit(1);
}

// Export as CSV
const packets = lap.telemetry;
const headers = Object.keys(packets[0]);
const csvRows = [headers.join(",")];
for (const p of packets) {
  csvRows.push(headers.map((h) => (p as unknown as Record<string, unknown>)[h] ?? 0).join(","));
}

const outPath = resolve(import.meta.dir, "../../client/public/demo-lap.csv");
await Bun.write(outPath, csvRows.join("\n"));
const stats = Bun.file(outPath);
console.log(`Wrote ${packets.length} packets to ${outPath} (${((await stats.arrayBuffer()).byteLength / 1024).toFixed(0)} KB)`);
