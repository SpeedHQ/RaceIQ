import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { bench, do_not_optimize, group } from "mitata";

import { parseRawLapFramesFromBuffer, type LapReplaySource } from "../../server/db/telemetry-replay-storage";
import { resolveTelemetryReplay } from "../../server/telemetry/replay";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames } from "../../server/games/registry";
import type { GameId } from "../../shared/games/ids";
import { iterateSessionFrameRecords } from "../../server/session-capture/framing";
import { runMitataBenchmarks } from "./mitata-harness";

export const REPLAY_PARSE_ALIAS = "replay/parse 20,000 raw lap frames";
export const REPLAY_RESOLVE_ALIAS = "replay/resolve 20,000 canonical envelopes";
export const SEED_SCAN_ALIAS = "replay/full seed metadata scan";
export const LATE_F1_ALIAS = "replay/late F1 lap";
export const SAME_SESSION_ALIAS = "replay/two separated same-session laps";
export const CROSS_SESSION_ALIAS = "replay/two cross-session laps";
export const REPLAY_ALIASES = [REPLAY_PARSE_ALIAS, REPLAY_RESOLVE_ALIAS, SEED_SCAN_ALIAS, LATE_F1_ALIAS, SAME_SESSION_ALIAS, CROSS_SESSION_ALIAS] as const;

const FRAME_COUNT = 20_000;
const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";
const FM_FIXTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const F1_FIXTURES = [
  "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz",
  "test/artifacts/sessions/f1-2025-2026-04-22T11-42-43-029Z.bin.gz",
] as const;
const SEMANTIC_IDS = ["motion.speed", "inputs.accel", "inputs.brake", "inputs.gear", "inputs.clutch-percent", "timing.current-lap", "timing.lap-number", "timing.distance-traveled"] as const;
type Case = { name: string; gameId: GameId; capture: Buffer; offsets: number[]; counts: number[]; run: () => unknown; expected: string };
let capture: Buffer;
let packets: TelemetryPacket[];
let cases: Case[] = [];
const source: LapReplaySource = { id: 1, sessionId: 1, createdAt: "2026-04-21T20:24:34.810Z", gameId: "ac-evo", rawFile: null, rawByteOffset: 12, rawFrameCount: FRAME_COUNT };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const records = (buf: Buffer) => [...iterateSessionFrameRecords(buf)];

function selectedAlias(): typeof REPLAY_ALIASES[number] {
  const value = process.env.REPLAY_BENCH_CASE ?? REPLAY_PARSE_ALIAS;
  const aliases: Record<string, typeof REPLAY_ALIASES[number]> = { parse: REPLAY_PARSE_ALIAS, resolve: REPLAY_RESOLVE_ALIAS };
  if (REPLAY_ALIASES.includes(value as never)) return value as typeof REPLAY_ALIASES[number];
  if (aliases[value]) return aliases[value];
  throw new Error(`Unknown REPLAY_BENCH_CASE: ${value}`);
}

function sliceReplay(buf: Buffer, gameId: GameId, start: number, count: number): TelemetryPacket[] {
  const rs = records(buf);
  return parseRawLapFramesFromBuffer(buf, rs[start]!.offset, count, gameId, "<benchmark capture>");
}

function scanMetadata(buf: Buffer, gameId: GameId): unknown[] {
  const adapter = getAllServerGames().find((candidate) => candidate.canHandle(records(buf)[0]!.frame));
  if (!adapter?.tryParseLapIndex) throw new Error(`No indexed adapter for ${gameId}`);
  const state = adapter.createParserState?.() ?? null;
  const result: unknown[] = [];
  for (const record of records(buf)) {
    const sample = adapter.tryParseLapIndex(record.frame, state);
    if (sample) result.push(sample);
  }
  return result;
}

export async function setup(): Promise<void> {
  initGameAdapters();
  initServerGameAdapters();
  capture = Buffer.from(gunzipSync(Buffer.from(await Bun.file(FIXTURE).arrayBuffer())));
  packets = parseRawLapFramesFromBuffer(capture, 12, FRAME_COUNT, "ac-evo", FIXTURE);
  const selected = selectedAlias();
  if (selected === REPLAY_PARSE_ALIAS) return;
  const envelopes = resolveTelemetryReplay(1, source, packets, SEMANTIC_IDS).envelopes;
  if (packets.length < FRAME_COUNT || packets.length > FRAME_COUNT + 1 || envelopes.length < FRAME_COUNT || envelopes.length > FRAME_COUNT + 1) throw new Error("Baseline replay output count mismatch");
  if (selected === REPLAY_RESOLVE_ALIAS) return;
  const acRecords = records(capture);
  const mid = Math.floor(acRecords.length / 2);
  const f1 = Buffer.from(gunzipSync(Buffer.from(await Bun.file(F1_FIXTURES[0]).arrayBuffer())));
  const f1b = Buffer.from(gunzipSync(Buffer.from(await Bun.file(F1_FIXTURES[1]).arrayBuffer())));
  const fm = Buffer.from(gunzipSync(Buffer.from(await Bun.file(FM_FIXTURE).arrayBuffer())));
  const lateStart = Math.max(0, records(f1).length - 5000);
  const same = () => [sliceReplay(capture, "ac-evo", 0, 1000), sliceReplay(capture, "ac-evo", mid, 1000)];
  const cross = () => [sliceReplay(f1, "f1-2025", 0, 1000), sliceReplay(f1b, "f1-2025", 0, 1000)];
  cases = [
    { name: SEED_SCAN_ALIAS, gameId: "fm-2023", capture: fm, offsets: [], counts: [], run: () => scanMetadata(fm, "fm-2023"), expected: "" },
    { name: LATE_F1_ALIAS, gameId: "f1-2025", capture: f1, offsets: [], counts: [], run: () => sliceReplay(f1, "f1-2025", lateStart, 5000), expected: "" },
    { name: SAME_SESSION_ALIAS, gameId: "ac-evo", capture, offsets: [], counts: [], run: same, expected: "" },
    { name: CROSS_SESSION_ALIAS, gameId: "f1-2025", capture: f1, offsets: [], counts: [], run: cross, expected: "" },
  ];
  for (const item of cases) item.expected = digest(item.run());
}

export function runIteration(): unknown {
  switch (selectedAlias()) {
    case REPLAY_PARSE_ALIAS:
      return parseRawLapFramesFromBuffer(capture, 12, FRAME_COUNT, "ac-evo", FIXTURE);
    case REPLAY_RESOLVE_ALIAS:
      return resolveTelemetryReplay(1, source, packets, SEMANTIC_IDS);
    default: {
      const item = cases.find((entry) => entry.name === selectedAlias());
      if (!item) throw new Error(`Unknown benchmark case: ${selectedAlias()}`);
      return item.run();
    }
  }
}

group("replay process", () => {
  bench(REPLAY_PARSE_ALIAS, () => do_not_optimize(parseRawLapFramesFromBuffer(capture, 12, FRAME_COUNT, "ac-evo", FIXTURE)));
  bench(REPLAY_RESOLVE_ALIAS, () => do_not_optimize(resolveTelemetryReplay(1, source, packets, SEMANTIC_IDS)));
  for (const item of cases) bench(item.name, () => do_not_optimize(item.run()));
});

if (import.meta.main) {
  await setup();
  const selected = selectedAlias();
  if (selected !== REPLAY_PARSE_ALIAS && selected !== REPLAY_RESOLVE_ALIAS) {
    const item = cases.find((entry) => entry.name === selected)!;
    if (digest(item.run()) !== item.expected) throw new Error(`${selected} output changed before timing`);
  }
  await runMitataBenchmarks(process.env.BENCH_OUTPUT ?? "replay-process-results.json");
}
