import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { NullSessionRecorderAdapter, type DbAdapter, type SessionIdentity } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { initServerGameAdapters } from "../../src/games/init";
import type { GameId } from "@raceiq/shared/games/ids";
import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";

class MemoryDb implements DbAdapter {
  #id = 1;
  identities: (SessionIdentity | null)[] = [];
  async insertSession(_car: number, _track: number, _game: GameId, _type?: string, _version?: TelemetryVersionIdentity, _ownership?: SessionOwnership, identity?: SessionIdentity) { this.identities.push(identity ?? null); return this.#id++; }
  async insertLap() { return this.#id++; }
  async deleteLap() {}
  async setLapMetrics() {}
  async updateLapCarSetup() {}
  async getLaps() { return []; }
  async updateSessionRawFile() {}
  async updateSessionCarTrack() {}
  async getTuneAssignment() { return null; }
  async getLapsForExclusionScope() { return []; }
  async setLapAutoExclusion() {}
  async getLapExperimentScope() { return { experimentId: null, tuneId: null }; }
}

const [gameId, fixture] = Bun.argv.slice(2);
if (!gameId || !fixture) throw new Error("Expected game id and fixture path");
initServerGameAdapters();
const bytes = await readFile(fixture);
const input = createInterface({ input: process.stdin });
const commands = input[Symbol.asyncIterator]();
const send = (event: Record<string, unknown>) => process.stdout.write(`@recorder-memory ${JSON.stringify(event)}\n`);
send({ event: "ready" });
if ((await commands.next()).value !== "go") throw new Error("Expected go command");
const result = await importSessionBin(bytes, gameId as GameId, { dbAdapter: new MemoryDb(), recorder: new NullSessionRecorderAdapter() });
send({ event: "done", packetCount: result.packetCount, lapCount: result.laps.length });
if ((await commands.next()).value !== "release") throw new Error("Expected release command");
// Keep outcomes reachable until the parent has captured its final RSS sample.
send({ event: "released", packetCount: result.packetCount, lapCount: result.laps.length });
input.close();
