import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { ServerGameAdapter } from "./types";
import { getAllServerGames, getRunningGame } from "./registry";

// Per-game parser state (e.g. F1StateAccumulator), keyed by game ID
const parserStates = new Map<string, unknown>();
let _statesInitialized = false;

function ensureStates() {
  if (_statesInitialized) return;
  _statesInitialized = true;
  for (const adapter of getAllServerGames()) {
    const state = adapter.createParserState();
    if (state != null) parserStates.set(adapter.id, state);
  }
}

const PARSER_ANCHOR_INTERVAL = 64;
const MAX_ANCHOR_DELTA_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;

/** Explicit limits; starts older than retained interval return no checkpoint. */
export const PARSER_INITIALIZATION_REPLAY_LIMITS = {
  maxFramesFromAnchor: PARSER_ANCHOR_INTERVAL,
  maxRetainedSourceBytes: MAX_ANCHOR_DELTA_BYTES,
  maxCheckpointBytes: MAX_CHECKPOINT_BYTES,
  coversUnboundedRetroactiveStarts: false,
} as const;
export interface ParserReplayLocator {
  readonly gameId: string;
  readonly sequence: number;
  /** Anchor payload plus preceding raw delta bytes; target frame excluded. */
  readonly byteCost: number;
}
export interface ParserInitializationReplayPlan {
  gameId: string;
  sequence: number;
  anchorSequence: number;
  anchorPayload: Uint8Array;
  precedingRecords: Array<{ sequence: number; frame: Buffer; timestampMs: number | undefined }>;
}
interface ParserAnchor { sequence: number; payload: Uint8Array; }
interface ParserDelta {
  sequence: number;
  frame: Buffer;
  timestampMs: number | undefined;
  previous: ParserDelta | null;
  byteCost: number;
}
interface ParserHistory {
  nextSequence: number;
  anchor: ParserAnchor | null;
  tail: ParserDelta | null;
  deltaBytes: number;
  usable: boolean;
}
interface ParserReplayLocatorData {
  anchor: ParserAnchor;
  precedingTail: ParserDelta | null;
}
const parserReplayLocatorData = new WeakMap<ParserReplayLocator, ParserReplayLocatorData>();
const parserHistories = new Map<string, ParserHistory>();
let lastParsedFrame: { gameId: string; sequence: number } | null = null;

export interface ParserSourceInput {
  gameId: GameId;
  sequence: number;
  frame: Buffer;
  timestampMs?: number;
  locator: ParserReplayLocator | null;
}
type ParserSourceListener = (input: ParserSourceInput) => void;
const parserSourceListeners = new Set<ParserSourceListener>();

/** Source frame is borrowed; listeners must not mutate or retain it. */
export function subscribeParserSource(listener: ParserSourceListener): () => void {
  parserSourceListeners.add(listener);
  return () => {
    parserSourceListeners.delete(listener);
  };
}

function checkpointFor(adapter: ServerGameAdapter): Uint8Array | null {
  const state = parserStates.get(adapter.id) ?? null;
  const payload = adapter.captureParserCheckpoint
    ? adapter.captureParserCheckpoint(state)
    : adapter.parserStateIsFrameLocal ? new Uint8Array() : null;
  return payload && payload.length <= MAX_CHECKPOINT_BYTES ? payload : null;
}

/** Reset mutable parser state and its replay anchor at an explicit source boundary. */
export function resetParserState(gameId: string): void {
  ensureStates();
  const adapter = getAllServerGames().find((candidate) => candidate.id === gameId);
  if (!adapter) return;
  const state = adapter.createParserState();
  if (state == null) parserStates.delete(gameId);
  else parserStates.set(gameId, state);
  const nextSequence = parserHistories.get(gameId)?.nextSequence ?? 0;
  const history: ParserHistory = {
    nextSequence, anchor: null, tail: null, deltaBytes: 0, usable: true,
  };
  parserHistories.set(gameId, history);
  const payload = checkpointFor(adapter);
  history.anchor = payload ? { sequence: nextSequence, payload } : null;
  history.usable = payload !== null;
}

function historyFor(gameId: string): ParserHistory {
  let history = parserHistories.get(gameId);
  if (!history) {
    history = { nextSequence: 0, anchor: null, tail: null, deltaBytes: 0, usable: true };
    parserHistories.set(gameId, history);
  }
  return history;
}

function trackParserInput(adapter: ServerGameAdapter, frame: Buffer, timestampMs?: number): number {
  const history = historyFor(adapter.id);
  const sequence = history.nextSequence++;
  if (sequence % PARSER_ANCHOR_INTERVAL === 0) {
    const payload = checkpointFor(adapter);
    history.anchor = payload ? { sequence, payload } : null;
    history.tail = null;
    history.deltaBytes = 0;
    history.usable = payload !== null;
  }
  const precedingTail = history.tail;
  if (history.usable && history.anchor) {
    if (history.deltaBytes + frame.length > MAX_ANCHOR_DELTA_BYTES) {
      history.usable = false;
      history.anchor = null;
      history.tail = null;
      history.deltaBytes = 0;
    } else {
      history.tail = {
        sequence,
        frame: Buffer.from(frame),
        timestampMs,
        previous: precedingTail,
        byteCost: history.deltaBytes + frame.length,
      };
      history.deltaBytes += frame.length;
    }
  }
  lastParsedFrame = { gameId: adapter.id, sequence };
  if (parserSourceListeners.size > 0) {
    const anchor = history.anchor;
    const locator = history.usable && anchor
      ? Object.freeze({
          gameId: adapter.id,
          sequence,
          byteCost: anchor.payload.length + (precedingTail?.byteCost ?? 0),
        })
      : null;
    if (locator && anchor) parserReplayLocatorData.set(locator, { anchor, precedingTail });
    const input: ParserSourceInput = {
      gameId: adapter.id as GameId, sequence, frame, timestampMs, locator,
    };
    let remaining = parserSourceListeners.size;
    for (const listener of parserSourceListeners) {
      if (remaining-- === 0) break;
      listener(input);
    }
  }
  return sequence;
}


function parseRecognizedFrame(
  adapter: ServerGameAdapter,
  frame: Buffer,
  timestampMs?: number,
): TelemetryPacket | null {
  trackParserInput(adapter, frame, timestampMs);
  return adapter.tryParse(frame, parserStates.get(adapter.id), timestampMs);
}

/**
 * Track ingress for frame-local parsers that preserve legacy direct decoding
 * instead of calling parsePacket. Stateful parsers must use parsePacket.
 */
export function trackFrameLocalParserInput(
  gameId: string,
  frame: Buffer,
  timestampMs?: number,
): number | null {
  ensureStates();
  const adapter = getAllServerGames().find((candidate) => candidate.id === gameId);
  if (!adapter?.parserStateIsFrameLocal || !adapter.canHandle(frame)) return null;
  return trackParserInput(adapter, frame, timestampMs);
}

/** Latest recognized input frame; caller may bind sequence to source coordinates. */
export function getLastParsedFrameSequence(): { gameId: string; sequence: number } | null {
  return lastParsedFrame;
}

/**
 * Materialize bounded replay data from immutable locator. Copies occur only
 * when a candidate is accepted, never per-frame beyond the existing ring copy.
 */
export function materializeParserInitializationPlan(
  locator: ParserReplayLocator,
): ParserInitializationReplayPlan | null {
  const data = parserReplayLocatorData.get(locator);
  if (!data || locator.sequence < data.anchor.sequence ||
      locator.sequence - data.anchor.sequence > PARSER_ANCHOR_INTERVAL ||
      locator.byteCost > MAX_ANCHOR_DELTA_BYTES + MAX_CHECKPOINT_BYTES) return null;
  const reverseRecords: ParserDelta[] = [];
  let delta = data.precedingTail;
  while (delta && delta.sequence >= data.anchor.sequence) {
    reverseRecords.push(delta);
    delta = delta.previous;
  }
  if (reverseRecords.length !== locator.sequence - data.anchor.sequence ||
      reverseRecords.reduce((bytes, record) => bytes + record.frame.length, data.anchor.payload.length) !== locator.byteCost) {
    return null;
  }
  reverseRecords.reverse();
  return {
    gameId: locator.gameId,
    sequence: locator.sequence,
    anchorSequence: data.anchor.sequence,
    anchorPayload: data.anchor.payload.slice(),
    precedingRecords: reverseRecords.map((record) => ({
      sequence: record.sequence,
      frame: Buffer.from(record.frame),
      timestampMs: record.timestampMs,
    })),
  };
}

/** Replay a captured plan on a worker/task boundary and return exact pre-frame state. */
export function replayParserInitializationPlan(plan: ParserInitializationReplayPlan): Uint8Array | null {
  const adapter = getAllServerGames().find((candidate) => candidate.id === plan.gameId);
  if (!adapter) return null;
  let state = adapter.createParserState();
  state = adapter.restoreParserCheckpoint
    ? adapter.restoreParserCheckpoint(state, plan.anchorPayload)
    : adapter.parserStateIsFrameLocal && plan.anchorPayload.length === 0 ? state : null;
  if (state === null && !adapter.parserStateIsFrameLocal) return null;
  for (const record of plan.precedingRecords) {
    adapter.tryParse(record.frame, state, record.timestampMs);
  }
  if (adapter.captureParserCheckpoint) {
    const payload = adapter.captureParserCheckpoint(state);
    return payload && payload.length <= MAX_CHECKPOINT_BYTES ? payload : null;
  }
  return adapter.parserStateIsFrameLocal ? new Uint8Array() : null;
}


let _seenUnknown = false;

// Cache the detected game to avoid getRunningGame() on every packet.
// Re-checked when canHandle fails (game might have changed).
let _cachedGame: ReturnType<typeof getRunningGame> = null;
let _cachedGameCheckedAt = 0;

/**
 * Parse a UDP packet using the running game's adapter.
 * Caches the detected game for speed — re-probes on miss or every 5 seconds.
 */
export function parsePacket(buf: Buffer, timestampMs?: number): TelemetryPacket | null {
  lastParsedFrame = null;
  ensureStates();
  if (_cachedGame?.canHandle(buf)) return parseRecognizedFrame(_cachedGame, buf, timestampMs);

  const now = Date.now();
  if (now - _cachedGameCheckedAt > 5000 || !_cachedGame) {
    _cachedGameCheckedAt = now;
    _cachedGame = getRunningGame();
    if (_cachedGame?.canHandle(buf)) return parseRecognizedFrame(_cachedGame, buf, timestampMs);
  }

  for (const adapter of getAllServerGames()) {
    if (adapter.canHandle(buf)) {
      _cachedGame = adapter;
      return parseRecognizedFrame(adapter, buf, timestampMs);
    }
  }

  if (!_seenUnknown) {
    _seenUnknown = true;
    const hex = buf.slice(0, 4).toString("hex").match(/../g)?.join(" ") ?? "";
    console.log(
      `[DEBUG UNKNOWN] Packet matches no registered game format: ` +
      `bufLen=${buf.length} first4bytes=[${hex}]`
    );
  }
  return null;
}

/** Get the game currently being detected from UDP packets. Returns null if no game detected yet. */
export function getCurrentDetectedGame(): ReturnType<typeof getRunningGame> {
  return _cachedGame;
}
