import type { TelemetryPacket, LapMeta, LiveSectorData, LivePitData, GameId } from "../shared/types";
import { insertSession, insertLap, getLaps } from "./db/queries";
import { getTuneAssignment } from "./db/tune-queries";
import { wsManager } from "./ws";

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
  profileId: number | null;
  tuneId: number | null;
  invalidReason: string | null;
  sectors: { s1: number; s2: number; s3: number } | null;
  packets: TelemetryPacket[];
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
    packets: TelemetryPacket[],
    profileId: number | null,
    tuneId: number | null,
    invalidReason: string | null,
    sectors: { s1: number; s2: number; s3: number } | null
  ): Promise<number>;
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]>;
  getTuneAssignment(
    carOrdinal: number,
    trackOrdinal: number
  ): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null>;
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
  insertLap(sessionId: number, lapNumber: number, lapTime: number, isValid: boolean, packets: TelemetryPacket[], profileId: number | null, tuneId: number | null, invalidReason: string | null, sectors: { s1: number; s2: number; s3: number } | null): Promise<number> {
    return insertLap(sessionId, lapNumber, lapTime, isValid, packets, profileId, tuneId, invalidReason, sectors);
  }
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]> {
    return getLaps(gameId, limit);
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

  insertLap(sessionId: number, lapNumber: number, lapTime: number, isValid: boolean, packets: TelemetryPacket[], profileId: number | null, tuneId: number | null, invalidReason: string | null, sectors: { s1: number; s2: number; s3: number } | null): Promise<number> {
    this.laps.push({ sessionId, lapNumber, lapTime, isValid, profileId, tuneId, invalidReason, sectors, packets });
    return Promise.resolve(++this._lapId);
  }

  getLaps(_gameId: GameId, _limit: number): Promise<LapMeta[]> {
    return Promise.resolve([]);
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
