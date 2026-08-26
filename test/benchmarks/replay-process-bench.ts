import { gunzipSync } from "node:zlib";

import { parseRawLapFramesFromBuffer, type LapReplaySource } from "../../server/db/telemetry-replay-storage";
import { resolveTelemetryReplay } from "../../server/telemetry/replay";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
export const REPLAY_PARSE_ALIAS = "replay/parse 20,000 raw lap frames";
export const REPLAY_RESOLVE_ALIAS = "replay/resolve 20,000 canonical envelopes";
export const REPLAY_ALIASES = [REPLAY_PARSE_ALIAS, REPLAY_RESOLVE_ALIAS] as const;

const FRAME_COUNT = 20_000;
const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";
const SEMANTIC_IDS = ["motion.speed", "inputs.accel", "inputs.brake", "inputs.gear", "inputs.clutch-percent", "timing.current-lap", "timing.lap-number", "timing.distance-traveled"] as const;

let capture: Buffer;
let packets: TelemetryPacket[];
const source: LapReplaySource = { id: 1, sessionId: 1, createdAt: "2026-04-21T20:24:34.810Z", gameId: "ac-evo", rawFile: null, rawByteOffset: 12, rawFrameCount: FRAME_COUNT };

function selectedAlias(): typeof REPLAY_ALIASES[number] {
  const value = process.env.REPLAY_BENCH_CASE ?? REPLAY_PARSE_ALIAS;
  if (value === REPLAY_PARSE_ALIAS || value === "parse") return REPLAY_PARSE_ALIAS;
  if (value === REPLAY_RESOLVE_ALIAS || value === "resolve") return REPLAY_RESOLVE_ALIAS;
  throw new Error(`Unknown REPLAY_BENCH_CASE: ${value}`);
}

export async function setup(): Promise<void> {
  initGameAdapters();
  initServerGameAdapters();
  capture = Buffer.from(gunzipSync(Buffer.from(await Bun.file(FIXTURE).arrayBuffer())));
  packets = parseRawLapFramesFromBuffer(capture, 12, FRAME_COUNT, "ac-evo", FIXTURE);
  if (packets.length < FRAME_COUNT || packets.length > FRAME_COUNT + 1) throw new Error(`Expected ${FRAME_COUNT}-${FRAME_COUNT + 1} packets, received ${packets.length}`);
  const envelopes = resolveTelemetryReplay(1, source, packets, SEMANTIC_IDS).envelopes;
  if (envelopes.length < FRAME_COUNT || envelopes.length > FRAME_COUNT + 1) throw new Error(`Expected ${FRAME_COUNT}-${FRAME_COUNT + 1} envelopes, received ${envelopes.length}`);
}

export function runIteration(): unknown {
  if (selectedAlias() === REPLAY_PARSE_ALIAS) return parseRawLapFramesFromBuffer(capture, 12, FRAME_COUNT, "ac-evo", FIXTURE);
  return resolveTelemetryReplay(1, source, packets, SEMANTIC_IDS);
}
