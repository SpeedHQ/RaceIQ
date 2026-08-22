/**
 * WebSocket manager: bridges UDP telemetry to browser clients.
 *
 * Two concerns handled here:
 * 1. Broadcast throttling — Forza sends at 60Hz, browsers only need 30Hz.
 *    We skip every other packet before serializing to JSON.
 * 2. Server-side history ring buffers — telemetry charts need ~60s of
 *    backfill when a client connects or a tab switches. Sampling at 10Hz
 *    (every 6th packet) keeps memory bounded at 600 samples per channel.
 */
import type { ServerWebSocket } from "bun";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import { semanticFixedNumbers, semanticNumber } from "../telemetry/semantic-samples";
import type { LiveProjection } from "../telemetry/live-projector";
import { IS_DEV, IS_E2E } from "./config/env";
import { isDevTelemetryControlMessageV1, type DevTelemetryControlMessageV1, type DevTelemetryPacketMessageV1, type DevTelemetrySubscriptionMessageV1 } from "../../shared/telemetry/live/contracts";

import type { LapMeta } from "../../shared/racing/sessions/types";
export interface WSData {
  createdAt: number;
  devTelemetrySubscribed: boolean;
}

const GRIP_MAX_SAMPLES = 600; // 60s of history at 10Hz sampling

export interface FourWheelHistory {
  fl: number[];
  fr: number[];
  rl: number[];
  rr: number[];
}

export interface GripHistoryData extends FourWheelHistory {}

export interface TelemetryHistoryData {
  grip: FourWheelHistory;
  temp: FourWheelHistory;
  wear: FourWheelHistory;
  slipAngle: FourWheelHistory;
  slipRatio: FourWheelHistory;
  suspension: FourWheelHistory;
  throttle: number[];
  brake: number[];
  speed: number[];
}

function pushFourWheelSample(target: FourWheelHistory, fl: number, fr: number, rl: number, rr: number): void {
  target.fl.push(fl);
  target.fr.push(fr);
  target.rl.push(rl);
  target.rr.push(rr);
  if (target.fl.length > GRIP_MAX_SAMPLES) {
    target.fl.shift();
    target.fr.shift();
    target.rl.shift();
    target.rr.shift();
  }
}

function pushScalarSample(target: number[], value: number | null): void {
  if (value === null) return;
  target.push(value);
  if (target.length > GRIP_MAX_SAMPLES) target.shift();
}

export class WebSocketManager {
  private clients = new Set<ServerWebSocket<WSData>>();
  private _packetCount = 0;
  private broadcastPeriodMs = 1000 / 60;
  private gripSampleCounter = 0; // Counts to 6 for 10Hz history sampling
  private gripHistory: GripHistoryData = { fl: [], fr: [], rl: [], rr: [] };
  /** Last broadcast JSON — sent to new clients so they don't start blank */
  private lastSchemaJson: string | null = null;
  /** Schema waiting for delivery to clients already connected when it changed. */
  private pendingSchemaJson: string | null = null;
  private lastFrameJson: string | null = null;
  private lastDevPacketJson: string | null = null;
  private readonly allowDevTelemetry = IS_DEV || IS_E2E;
  /** Injected getter for session laps — avoids circular import with pipeline */
  private _getSessionLaps: (() => readonly LapMeta[]) | null = null;
  /** Stale lap detection notification — sent to each new client on connect */
  private _staleSessionsNotification: Record<string, unknown> | null = null;
  /** Stale race-result notification — sent to each new client on connect */
  private _staleRaceResultsNotification: Record<string, unknown> | null = null;

  setSessionLapsProvider(fn: () => readonly LapMeta[]): void {
    this._getSessionLaps = fn;
  }

  setStaleSessionsNotification(payload: Record<string, unknown> | null): void {
    this._staleSessionsNotification = payload;
  }
  setStaleRaceResultsNotification(payload: Record<string, unknown> | null): void {
    this._staleRaceResultsNotification = payload;
  }
  private telemetryHistory: TelemetryHistoryData = {
    grip: { fl: [], fr: [], rl: [], rr: [] },
    temp: { fl: [], fr: [], rl: [], rr: [] },
    wear: { fl: [], fr: [], rl: [], rr: [] },
    slipAngle: { fl: [], fr: [], rl: [], rr: [] },
    slipRatio: { fl: [], fr: [], rl: [], rr: [] },
    suspension: { fl: [], fr: [], rl: [], rr: [] },
    throttle: [],
    brake: [],
    speed: [],
  };

  get connectedClients(): number {
    return this.clients.size;
  }
  get wantsDevTelemetry(): boolean {
    return this.allowDevTelemetry && [...this.clients].some((client) => client.data.devTelemetrySubscribed);
  }
  /** Monotonic count of semantic live publications — used by status interval to
   *  detect active pipeline flow regardless of source (UDP, ACC SHM, AC Evo
   *  SHM). Reset never; consumers track deltas. */
  get packetCount(): number {
    return this._packetCount;
  }

  setRefreshRate(hz: string): void {
    const rate = parseInt(hz, 10) || 60;
    this.broadcastPeriodMs = 1000 / (rate > 0 ? rate : 60);
    if (this._broadcastTimer) this.startBroadcastTimer();
  }

  addClient(ws: ServerWebSocket<WSData>): void {
    this.clients.add(ws);
    if (this.lastSchemaJson) {
      try {
        ws.send(this.lastSchemaJson);
      } catch {}
    }
    if (this.lastFrameJson) {
      try {
        ws.send(this.lastFrameJson);
      } catch {}
    }
    if (this.lastDevPacketJson && ws.data.devTelemetrySubscribed) {
      try {
        ws.send(this.lastDevPacketJson);
      } catch {}
    }
    // Send current session laps so recorded laps survive refresh
    const laps = this._getSessionLaps?.();
    if (laps && laps.length > 0) {
      try {
        ws.send(JSON.stringify({ type: "session-laps", laps }));
      } catch {}
    }
    // Send stale lap detection notification if any sessions need reprocessing
    if (this._staleSessionsNotification) {
      try {
        ws.send(JSON.stringify(this._staleSessionsNotification));
      } catch {}
    }
    if (this._staleRaceResultsNotification) {
      try {
        ws.send(JSON.stringify(this._staleRaceResultsNotification));
      } catch {}
    }
    console.log(`[WS] Client connected. Active: ${this.clients.size}`);
    if (this.clients.size === 1) this.startBroadcastTimer(); // first client — start pushing
  }

  removeClient(ws: ServerWebSocket<WSData>): void {
    this.clients.delete(ws);
    if (this.clients.size === 0) this.stopBroadcastTimer(); // no clients — stop pushing
    console.log(`[WS] Client disconnected. Active: ${this.clients.size}`);
  }
  disconnectClients(code = 1012, reason = "Server restart simulation"): void {
    for (const client of this.clients) {
      try {
        client.close(code, reason);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  getGripHistory(): GripHistoryData {
    return this.gripHistory;
  }

  getTelemetryHistory(): TelemetryHistoryData {
    return this.telemetryHistory;
  }

  /**
   * Broadcast server status so clients stay in sync without polling.
   * Fired every 1s from the UDP listener's interval timer.
   */
  broadcastStatus(status: {
    telemetryPps: number;
    udpPps: number;
    isRaceOn: boolean;
    droppedPackets: number;
    udpPort: number;
    detectedGame: { id: string; name: string } | null;
    currentSession: { id: number; carOrdinal: number; trackOrdinal: number } | null;
  }): void {
    if (this.clients.size === 0) return;
    const json = JSON.stringify({ type: "status", ...status });
    for (const client of this.clients) {
      try {
        client.send(json);
      } catch {
        /* cleaned up on next telemetry broadcast */
      }
    }
  }

  /**
   * Broadcast an arbitrary JSON notification to all connected clients.
   * Used for update-available and other server-initiated events.
   */
  broadcastNotification(payload: Record<string, unknown>): void {
    if (this.clients.size === 0) return;
    const json = JSON.stringify(payload);
    for (const client of this.clients) {
      try {
        client.send(json);
      } catch {}
    }
  }

  broadcastDevState(payload: Record<string, unknown>): void {
    if (this.clients.size === 0) return;
    const json = JSON.stringify({ type: "dev-state", ...payload });
    for (const client of this.clients) {
      try {
        client.send(json);
      } catch {}
    }
  }

  publishTelemetry(projection: LiveProjection): void {
    this._packetCount++;
    if (projection.schema) {
      this.lastSchemaJson = JSON.stringify(projection.schema);
      if (this.clients.size > 0) this.pendingSchemaJson = this.lastSchemaJson;
    }
    if (projection.frame) this.lastFrameJson = JSON.stringify(projection.frame);
    this._recordSemanticHistory(projection.sample);
  }

  handleMessage(ws: ServerWebSocket<WSData>, message: string | Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : message.toString());
    } catch {
      parsed = null;
    }
    if (!isDevTelemetryControlMessageV1(parsed)) {
      ws.send(JSON.stringify({ type: "subscription", channel: "dev-telemetry", subscribed: false, error: "invalid-message" } satisfies DevTelemetrySubscriptionMessageV1));
      return;
    }
    const control = parsed as DevTelemetryControlMessageV1;
    if (!this.allowDevTelemetry) {
      ws.data.devTelemetrySubscribed = false;
      ws.send(JSON.stringify({ type: "subscription", channel: "dev-telemetry", subscribed: false, error: "not-available" } satisfies DevTelemetrySubscriptionMessageV1));
      return;
    }
    ws.data.devTelemetrySubscribed = control.type === "subscribe";
    ws.send(JSON.stringify({ type: "subscription", channel: "dev-telemetry", subscribed: ws.data.devTelemetrySubscribed } satisfies DevTelemetrySubscriptionMessageV1));
    if (ws.data.devTelemetrySubscribed && this.lastDevPacketJson) ws.send(this.lastDevPacketJson);
  }

  stageDevTelemetry(packet: TelemetryPacket): void {
    this.lastDevPacketJson = JSON.stringify({ type: "dev-telemetry", protocolVersion: 1, packet } satisfies DevTelemetryPacketMessageV1);
  }

  flushLatest(): void {
    this._pushToClients();
  }

  // Latest state — written by packet handler, read by broadcast timer
  private _broadcastTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Sample resolver-backed telemetry history at ~10Hz.
   * Unavailable semantic values do not produce chart points.
   */
  private _recordSemanticHistory(sample: SemanticTelemetrySample): void {
    this.gripSampleCounter++;
    if (this.gripSampleCounter % 6 !== 0) return;

    const grip = semanticFixedNumbers(sample, "tires.tire-combined-slip", 4);
    if (grip) {
      pushFourWheelSample(this.gripHistory, grip[0], grip[1], grip[2], grip[3]);
      pushFourWheelSample(this.telemetryHistory.grip, grip[0], grip[1], grip[2], grip[3]);
    }

    const temp = semanticFixedNumbers(sample, "tire.temperature.average", 4);
    if (temp) {
      pushFourWheelSample(this.telemetryHistory.temp, temp[0], temp[1], temp[2], temp[3]);
    }
    const wear = semanticFixedNumbers(sample, "tires.tire-wear", 4);
    if (wear) {
      pushFourWheelSample(this.telemetryHistory.wear, wear[0], wear[1], wear[2], wear[3]);
    }
    const slipAngle = semanticFixedNumbers(sample, "tires.tire-slip-angle", 4);
    if (slipAngle) {
      pushFourWheelSample(this.telemetryHistory.slipAngle, slipAngle[0], slipAngle[1], slipAngle[2], slipAngle[3]);
    }
    const slipRatio = semanticFixedNumbers(sample, "tires.tire-slip-ratio", 4);
    if (slipRatio) {
      pushFourWheelSample(this.telemetryHistory.slipRatio, slipRatio[0], slipRatio[1], slipRatio[2], slipRatio[3]);
    }
    const suspension = semanticFixedNumbers(sample, "suspension.norm-suspension-travel", 4);
    if (suspension) {
      pushFourWheelSample(this.telemetryHistory.suspension, suspension[0], suspension[1], suspension[2], suspension[3]);
    }
    pushScalarSample(this.telemetryHistory.throttle, semanticNumber(sample, "inputs.accel"));
    pushScalarSample(this.telemetryHistory.brake, semanticNumber(sample, "inputs.brake"));
    pushScalarSample(this.telemetryHistory.speed, semanticNumber(sample, "motion.speed"));
  }

  /** Start a deadline-based broadcast loop that preserves fractional periods. */
  private startBroadcastTimer(): void {
    this.stopBroadcastTimer();
    const periodMs = this.broadcastPeriodMs;
    let nextBroadcastAt = performance.now() + periodMs;
    const tick = () => {
      this._pushToClients();
      nextBroadcastAt += periodMs;
      const now = performance.now();
      if (nextBroadcastAt <= now) nextBroadcastAt += (Math.floor((now - nextBroadcastAt) / periodMs) + 1) * periodMs;
      this._broadcastTimer = setTimeout(tick, Math.max(0, nextBroadcastAt - now));
    };
    this._broadcastTimer = setTimeout(tick, periodMs);
  }

  /** Stop the broadcast timer. */
  private stopBroadcastTimer(): void {
    if (this._broadcastTimer) {
      clearTimeout(this._broadcastTimer);
      this._broadcastTimer = null;
    }
  }

  private _pushToClients(): void {
    const schemaJson = this.pendingSchemaJson;
    const deadClients: ServerWebSocket<WSData>[] = [];
    for (const client of this.clients) {
      try {
        if (schemaJson) client.send(schemaJson);
        if (this.lastFrameJson) client.send(this.lastFrameJson);
        if (this.lastDevPacketJson && client.data.devTelemetrySubscribed) client.send(this.lastDevPacketJson);
      } catch {
        deadClients.push(client);
      }
    }
    this.pendingSchemaJson = null;
    for (const dead of deadClients) this.clients.delete(dead);
  }
}

export const wsManager = new WebSocketManager();
