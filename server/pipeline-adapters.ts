import { resolve } from "path";
import { mkdirSync } from "fs";
import type { LapMeta, LiveSectorData, LivePitData, GameId, TelemetryPacket } from "../shared/types";
import { insertSession, insertLap, getLaps, updateSessionRawFile } from "./db/queries";
import { getTuneAssignment } from "./db/tune-queries";
import { wsManager } from "./ws";
import { UdpRecorder } from "./udp-recorder";
import { resolveDataDir } from "./data-dir";

export interface CapturedSession {
  carOrdinal: number;
  trackOrdinal: number;
  gameId: GameId;
  sessionType?: string;
}

export interface CapturedLap {
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  rawByteOffset: number | null;
  rawFrameCount: number;
  profileId: number | null;
  tuneId: number | null;
  invalidReason: string | null;
  sectors: { s1: number; s2: number; s3: number } | null;
  /** Populated by parseDump helpers for test assertions only — not present in production. */
  packets?: TelemetryPacket[];
}

export interface DbAdapter {
  insertSession(
    carOrdinal: number,
    trackOrdinal: number,
    gameId: GameId,
    sessionType?: string
  ): Promise<number>;
  insertLap(
    sessionId: number,
    lapNumber: number,
    lapTime: number,
    isValid: boolean,
    rawByteOffset: number | null,
    rawFrameCount: number,
    profileId: number | null,
    tuneId: number | null,
    invalidReason: string | null,
    sectors: { s1: number; s2: number; s3: number } | null
  ): Promise<number>;
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]>;
  updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string): Promise<void>;
  getTuneAssignment(
    carOrdinal: number,
    trackOrdinal: number
  ): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null>;
}

/**
 * Pluggable session recorder — wraps the raw binary dump file pipeline uses
 * to replay sessions later. Real impl writes to `<DATA_DIR>/sessions/<game>/`.
 * Null impl no-ops so tests re-feeding dumps don't duplicate the recording
 * back to disk.
 *
 * `epoch` bumps on each successful `start()` so the pipeline can detect a
 * session rotation triggered inside `detector.feed` (packet landed on the
 * old recorder, a new session opened, need to re-write the packet).
 */
export interface SessionRecorderAdapter {
  readonly active: boolean;
  readonly path: string | null;
  readonly epoch: number;
  start(gameId: GameId): void;
  writeMetaFrame(): void;
  writePacket(buf: Buffer): void;
  getCurrentByteOffset(): number;
  flush(): void;
  stop(): Promise<void>;
}

export interface WsAdapter {
  broadcast(
    packet: TelemetryPacket,
    sectors?: LiveSectorData | null,
    pit?: LivePitData | null
  ): void;
  broadcastNotification(event: Record<string, unknown>): void;
  broadcastDevState(state: Record<string, unknown>): void;
}

/** Delegates to the real query functions. Used in production. */
export class RealDbAdapter implements DbAdapter {
  insertSession(carOrdinal: number, trackOrdinal: number, gameId: GameId, sessionType?: string): Promise<number> {
    return insertSession(carOrdinal, trackOrdinal, gameId, sessionType);
  }
  insertLap(sessionId: number, lapNumber: number, lapTime: number, isValid: boolean, rawByteOffset: number | null, rawFrameCount: number, profileId: number | null, tuneId: number | null, invalidReason: string | null, sectors: { s1: number; s2: number; s3: number } | null): Promise<number> {
    return insertLap(sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors);
  }
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]> {
    return getLaps(gameId, limit);
  }
  updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string): Promise<void> {
    return updateSessionRawFile(sessionId, rawFile, lapDetectorVersion);
  }
  getTuneAssignment(carOrdinal: number, trackOrdinal: number): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null> {
    return getTuneAssignment(carOrdinal, trackOrdinal);
  }
}

/** Delegates to wsManager singleton. Used in production. */
export class RealWsAdapter implements WsAdapter {
  broadcast(packet: TelemetryPacket, sectors?: LiveSectorData | null, pit?: LivePitData | null): void {
    wsManager.broadcast(packet, sectors, pit);
  }
  broadcastNotification(event: Record<string, unknown>): void {
    wsManager.broadcastNotification(event);
  }
  broadcastDevState(state: Record<string, unknown>): void {
    wsManager.broadcastDevState(state);
  }
}

/** Captures insertSession/insertLap calls in-memory. Used in tests via parseDump. */
export class CapturingDbAdapter implements DbAdapter {
  readonly sessions: CapturedSession[] = [];
  readonly laps: CapturedLap[] = [];
  private _sessionId = 0;
  private _lapId = 0;

  insertSession(carOrdinal: number, trackOrdinal: number, gameId: GameId, sessionType?: string): Promise<number> {
    this.sessions.push({ carOrdinal, trackOrdinal, gameId, sessionType });
    return Promise.resolve(++this._sessionId);
  }

  insertLap(sessionId: number, lapNumber: number, lapTime: number, isValid: boolean, rawByteOffset: number | null, rawFrameCount: number, profileId: number | null, tuneId: number | null, invalidReason: string | null, sectors: { s1: number; s2: number; s3: number } | null): Promise<number> {
    this.laps.push({ sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors });
    return Promise.resolve(++this._lapId);
  }

  getLaps(_gameId: GameId, _limit: number): Promise<LapMeta[]> {
    return Promise.resolve([]);
  }

  updateSessionRawFile(_sessionId: number, _rawFile: string, _lapDetectorVersion: string): Promise<void> {
    return Promise.resolve();
  }

  getTuneAssignment(_carOrdinal: number, _trackOrdinal: number): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null> {
    return Promise.resolve(null);
  }
}

/** No-op WebSocket adapter. Used in tests. */
export class NullWsAdapter implements WsAdapter {
  broadcast(_packet: TelemetryPacket, _sectors?: LiveSectorData | null, _pit?: LivePitData | null): void {}
  broadcastNotification(_event: Record<string, unknown>): void {}
  broadcastDevState(_state: Record<string, unknown>): void {}
}

/** No-op database adapter. Used in benchmarks and tests that don't need DB output. */
export class NullDbAdapter implements DbAdapter {
  insertSession(_carOrdinal: number, _trackOrdinal: number, _gameId: GameId, _sessionType?: string): Promise<number> {
    return Promise.resolve(1);
  }
  insertLap(_sessionId: number, _lapNumber: number, _lapTime: number, _isValid: boolean, _rawByteOffset: number | null, _rawFrameCount: number, _profileId: number | null, _tuneId: number | null, _invalidReason: string | null, _sectors: { s1: number; s2: number; s3: number } | null): Promise<number> {
    return Promise.resolve(1);
  }
  getLaps(_gameId: GameId, _limit: number): Promise<LapMeta[]> {
    return Promise.resolve([]);
  }
  updateSessionRawFile(_sessionId: number, _rawFile: string, _lapDetectorVersion: string): Promise<void> {
    return Promise.resolve();
  }
  getTuneAssignment(_carOrdinal: number, _trackOrdinal: number): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null> {
    return Promise.resolve(null);
  }
}

/** Real session recorder — writes raw UDP packets to `<DATA_DIR>/sessions/<game>/<timestamp>.bin`. */
export class RealSessionRecorderAdapter implements SessionRecorderAdapter {
  private _inner: UdpRecorder | null = null;
  private _epoch = 0;

  get active(): boolean { return this._inner?.recording ?? false; }
  get path(): string | null { return this._inner?.path ?? null; }
  get epoch(): number { return this._epoch; }

  start(gameId: GameId): void {
    const dataDir = resolveDataDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionDir = resolve(dataDir, "sessions", gameId);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = resolve(sessionDir, `${timestamp}.bin`);
    this._inner = new UdpRecorder();
    this._inner.start(filePath);
    this._epoch++;
  }

  writeMetaFrame(): void { this._inner?.writeMetaFrame(); }
  writePacket(buf: Buffer): void { this._inner?.writePacket(buf); }
  getCurrentByteOffset(): number { return this._inner?.getCurrentByteOffset() ?? 0; }
  flush(): void { this._inner?.flush(); }
  async stop(): Promise<void> {
    const inner = this._inner;
    this._inner = null;
    if (inner) await inner.stop();
  }
}

/** No-op session recorder — used in tests/benchmarks that re-feed recorded dumps. */
export class NullSessionRecorderAdapter implements SessionRecorderAdapter {
  get active(): boolean { return false; }
  get path(): string | null { return null; }
  get epoch(): number { return 0; }
  start(_gameId: GameId): void {}
  writeMetaFrame(): void {}
  writePacket(_buf: Buffer): void {}
  getCurrentByteOffset(): number { return 0; }
  flush(): void {}
  async stop(): Promise<void> {}
}

/** Capturing WebSocket adapter that records all events. Used in tests. */
export class CapturingWsAdapter implements WsAdapter {
  readonly broadcastedPackets: Array<{ packet: TelemetryPacket; sectors?: LiveSectorData | null; pit?: LivePitData | null }> = [];
  readonly broadcastedNotifications: Record<string, unknown>[] = [];
  readonly broadcastedDevStates: Record<string, unknown>[] = [];

  broadcast(packet: TelemetryPacket, sectors?: LiveSectorData | null, pit?: LivePitData | null): void {
    this.broadcastedPackets.push({ packet, sectors, pit });
  }

  broadcastNotification(event: Record<string, unknown>): void {
    this.broadcastedNotifications.push(event);
  }

  broadcastDevState(state: Record<string, unknown>): void {
    this.broadcastedDevStates.push(state);
  }
}
