import { parentPort } from "node:worker_threads";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { detectCorners } from "../lap-analysis/corners";
import { telemetryToSymptoms } from "../ai/tune-symptoms";
import { symptomsToIssues } from "../ai/tune-issues";

initGameAdapters();

parentPort!.on("message", (packets: TelemetryPacket[]) => {
  try {
    const corners = detectCorners(packets);
    const issues = symptomsToIssues(telemetryToSymptoms(packets, corners));
    parentPort!.postMessage({ issues });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
