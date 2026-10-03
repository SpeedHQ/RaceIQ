import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "@raceiq/shared/telemetry/live/contracts";
import { SEEDED_GAME_CASES } from "../seeded/cases";

interface SeededLap {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  trackOrdinal: number;
  isValid: boolean;
}

interface LiveTelemetryReplay {
  schema?: LiveTelemetrySchemaMessageV1;
  frames?: LiveTelemetryFrameMessageV1[];
}

interface LiveScreenshotSample {
  lap: SeededLap;
  schema: LiveTelemetrySchemaMessageV1;
  frame: LiveTelemetryFrameMessageV1;
}

const LIVE_SEMANTIC_IDS = [
  "motion.speed",
  "timing.lap-number",
  "timing.current-lap",
  "engine.current-engine-rpm",
  "inputs.gear",
  "tire.temperature.surface.representative",
  "tires.tire-wear",
  "tires.tire-pressure",
].join(",");

const samples = new Map<GameId, Promise<LiveScreenshotSample>>();

async function loadSample(request: APIRequestContext, gameId: GameId): Promise<LiveScreenshotSample> {
  const lapsResponse = await request.get(`/api/laps?gameId=${encodeURIComponent(gameId)}`);
  expect(lapsResponse.ok(), `${gameId} screenshot lap list`).toBe(true);
  const laps = (await lapsResponse.json()) as SeededLap[];
  const lap = laps.find((candidate) => candidate.isValid) ??
    laps.filter((candidate) => candidate.lapTime > 10).sort((a, b) => b.lapNumber - a.lapNumber || b.id - a.id)[0];
  expect(lap, `${gameId} screenshot telemetry fixture`).toBeDefined();
  if (!lap) throw new Error(`No screenshot telemetry fixture for ${gameId}`);

  const replayResponse = await request.get(`/api/dev/laps/${lap.id}/live-telemetry?semanticIds=${encodeURIComponent(LIVE_SEMANTIC_IDS)}`);
  expect(replayResponse.ok(), `${gameId} live telemetry projection`).toBe(true);
  const replay = (await replayResponse.json()) as LiveTelemetryReplay;
  expect(replay.schema, `${gameId} telemetry schema`).toBeDefined();
  expect(replay.frames?.length, `${gameId} first telemetry frame`).toBeGreaterThan(0);
  if (!replay.schema || !replay.frames?.[0]) throw new Error(`No live telemetry frame for ${gameId}`);

  return { lap, schema: replay.schema, frame: replay.frames[0] };
}

async function getSample(request: APIRequestContext, gameId: GameId): Promise<LiveScreenshotSample> {
  const cached = samples.get(gameId);
  if (cached) return cached;

  const pending = loadSample(request, gameId).catch((error: unknown) => {
    samples.delete(gameId);
    throw error;
  });
  samples.set(gameId, pending);
  return pending;
}

export async function mockLiveScreenshotTelemetry(page: Page, request: APIRequestContext, gameId: GameId): Promise<void> {
  const game = SEEDED_GAME_CASES.find((candidate) => candidate.gameId === gameId);
  expect(game, `${gameId} screenshot game metadata`).toBeDefined();
  if (!game) throw new Error(`No screenshot game metadata for ${gameId}`);
  const sample = await getSample(request, gameId);

  await page.routeWebSocket("**/ws", (socket) => {
    socket.send(JSON.stringify({
      type: "status",
      udpPps: 60,
      telemetryPps: 60,
      isRaceOn: true,
      droppedPackets: 0,
      udpPort: 5300,
      detectedGame: { id: game.gameId, name: game.name },
      currentSession: {
        id: sample.lap.sessionId,
        carOrdinal: sample.lap.carOrdinal,
        trackOrdinal: sample.lap.trackOrdinal,
        carId: sample.lap.carOrdinal,
        trackId: sample.lap.trackOrdinal,
      },
    }));
    socket.send(JSON.stringify(sample.schema));
    socket.send(JSON.stringify(sample.frame));
  });
}
