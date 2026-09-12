#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

bun -e '
import { LiveEngineerRuntime } from "./server/live-strategy/live-engineer-runtime.ts";

const states = ["fastest-in-class", "setting-race-pace", "within-class-pace", "off-class-pace", "outlier-lap"];
const now = () => 1_000_000;
const runtime = new LiveEngineerRuntime({ now, maxQueue: 3, cooldownMs: 60_000 });
runtime.reset("bench", 1);
const started = performance.now();
let selected = 0;
for (let iteration = 0; iteration < 20_000; iteration += 1) {
  runtime.clear();
  for (let index = 0; index < states.length; index += 1) {
    const relation = states[(iteration + index) % states.length];
    runtime.submit({
      candidateId: `bench-${iteration}-${index}`,
      decisionId: `bench-${iteration}-${index}/policy`,
      actionKey: "opponent-pace-status",
      cooldownGroup: "opponent-pace",
      sourceFactIds: ["bench-fact"],
      policyVersion: "bench-v1",
      renderParameters: { relation, scope: "class", playerLapNumber: 1, playerLapTimeMs: 60_000, benchmarkLapTimeMs: 60_000, deltaMs: 300, benchmarkKind: "session-best" },
      sessionId: "bench",
      timelineEpoch: 1,
      sourceSequence: index,
      priority: index === 4 ? "high" : "normal",
      createdSessionTimeMs: 999_000,
      expiresSessionTimeMs: 1_010_000,
    });
  }
  while (runtime.selectNext() !== null) selected += 1;
}
const elapsedMs = performance.now() - started;
console.log(`METRIC state_transition_ms=${elapsedMs.toFixed(3)}`);
console.log(`METRIC selected_transitions=${selected}`);
'
