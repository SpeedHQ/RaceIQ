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
import type { TelemetryPacket, LiveSectorData, LivePitData } from "../shared/types";

export interface WSData {
  createdAt: number;
}

const GRIP_MAX_SAMPLES = 600; // 60s of history at 10Hz sampling

export interface GripHistoryData {
  fl: number[];
  fr: number[];
  rl: number[];
  rr: number[];
}

export interface FourWheelHistory {
  fl: number[];
  fr: number[];
  rl: number[];
  rr: number[];
}

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

class WebSocketManager {
  private clients = new Set<ServerWebSocket<WSData>>();
  private packetCount = 0;
  private broadcastIntervalMs = 16; // default 60Hz
  private gripSampleCounter = 0; // Counts to 6 for 10Hz history sampling
  private gripHistory: GripHistoryData = { fl: [], fr: [], rl: [], rr: [] };
  /** Last broadcast JSON — sent to new clients so they don't start blank */
  private lastBroadcastJson: string | null = null;
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

  setRefreshRate(hz: string): void {
    const rate = parseInt(hz) || 60;
    this.broadcastIntervalMs = rate > 0 ? Math.round(1000 / rate) : 16;
    if (this._broadcastTimer) this.startBroadcastTimer(); // restart with new interval
  }

  addClient(ws: ServerWebSocket<WSData>): void {
    this.clients.add(ws);
    // Send last state so client doesn't start blank on refresh
    if (this.lastBroadcastJson) {
      try { ws.send(this.lastBroadcastJson); } catch {}
    }
    console.log(`[WS] Client connected. Active: ${this.clients.size}`);
    if (this.clients.size === 1) this.startBroadcastTimer(); // first client — start pushing
  }

  removeClient(ws: ServerWebSocket<WSData>): void {
    this.clients.delete(ws);
    if (this.clients.size === 0) this.stopBroadcastTimer(); // no clients — stop pushing
    console.log(`[WS] Client disconnected. Active: ${this.clients.size}`
    );
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
      try { client.send(json); } catch { /* cleaned up on next telemetry broadcast */ }
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
      try { client.send(json); } catch {}
    }
  }

  // Latest state — written by packet handler, read by broadcast timer
  private _latestPacket: TelemetryPacket | null = null;
  private _latestSectors: LiveSectorData | null = null;
  private _latestPit: LivePitData | null = null;
  private _broadcastTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Store the latest telemetry packet and sample history.
   * Does NOT send to clients — the broadcast timer handles that.
   */
  broadcast(packet: TelemetryPacket, sectors?: LiveSectorData | null, pit?: LivePitData | null): void {
    this.packetCount++;
    this._latestPacket = packet;
    if (sectors) this._latestSectors = sectors;
    if (pit) this._latestPit = pit;

    // Sample telemetry history at ~10Hz
    this.gripSampleCounter++;
    if (this.gripSampleCounter % 6 === 0) {
      const h = this.gripHistory;
      h.fl.push(Math.abs(packet.TireCombinedSlipFL));
      h.fr.push(Math.abs(packet.TireCombinedSlipFR));
      h.rl.push(Math.abs(packet.TireCombinedSlipRL));
      h.rr.push(Math.abs(packet.TireCombinedSlipRR));
      if (h.fl.length > GRIP_MAX_SAMPLES) {
        h.fl.shift(); h.fr.shift(); h.rl.shift(); h.rr.shift();
      }

      const t = this.telemetryHistory;
      const push4 = (target: FourWheelHistory, fl: number, fr: number, rl: number, rr: number) => {
        target.fl.push(fl); target.fr.push(fr); target.rl.push(rl); target.rr.push(rr);
        if (target.fl.length > GRIP_MAX_SAMPLES) {
          target.fl.shift(); target.fr.shift(); target.rl.shift(); target.rr.shift();
        }
      };
      push4(t.grip, Math.abs(packet.TireCombinedSlipFL), Math.abs(packet.TireCombinedSlipFR), Math.abs(packet.TireCombinedSlipRL), Math.abs(packet.TireCombinedSlipRR));
      push4(t.temp, packet.TireTempFL, packet.TireTempFR, packet.TireTempRL, packet.TireTempRR);
      push4(t.wear, packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR);
      push4(t.slipAngle, packet.TireSlipAngleFL, packet.TireSlipAngleFR, packet.TireSlipAngleRL, packet.TireSlipAngleRR);
      push4(t.slipRatio, packet.TireSlipRatioFL, packet.TireSlipRatioFR, packet.TireSlipRatioRL, packet.TireSlipRatioRR);
      push4(t.suspension, packet.NormSuspensionTravelFL, packet.NormSuspensionTravelFR, packet.NormSuspensionTravelRL, packet.NormSuspensionTravelRR);
      t.throttle.push(packet.Accel / 255);
      t.brake.push(packet.Brake / 255);
      t.speed.push(packet.Speed * 2.23694);
      if (t.throttle.length > GRIP_MAX_SAMPLES) { t.throttle.shift(); t.brake.shift(); t.speed.shift(); }
    }
  }

  /** Start the broadcast timer at the configured Hz. */
  startBroadcastTimer(): void {
    this.stopBroadcastTimer();
    this._broadcastTimer = setInterval(() => this._pushToClients(), this.broadcastIntervalMs);
  }

  /** Stop the broadcast timer. */
  stopBroadcastTimer(): void {
    if (this._broadcastTimer) {
      clearInterval(this._broadcastTimer);
      this._broadcastTimer = null;
    }
  }

  /** Push latest state to all WebSocket clients. Called by timer. */
  private _pushToClients(): void {
    const packet = this._latestPacket;
    if (!packet || this.clients.size === 0) return;

    // Strip heavy f1 sub-objects for broadcast
    let broadcastPacket: unknown = packet;
    if (packet.f1) {
      const { motionEx, ...lightF1 } = packet.f1;
      broadcastPacket = { ...packet, f1: lightF1 };
    }
    const extra: Record<string, unknown> = {};
    if (this._latestSectors) extra._sectors = this._latestSectors;
    if (this._latestPit) extra._pit = this._latestPit;
    const json = JSON.stringify(Object.keys(extra).length > 0 ? Object.assign({}, broadcastPacket, extra) : broadcastPacket);
    this.lastBroadcastJson = json;
    const deadClients: ServerWebSocket<WSData>[] = [];

    for (const client of this.clients) {
      try {
        client.send(json);
      } catch (err) {
        console.warn("[WS] Send failed, removing dead client:", err);
        deadClients.push(client);
      }
    }

    // Clean up dead clients
    for (const dead of deadClients) {
      this.clients.delete(dead);
    }
  }
}

export const wsManager = new WebSocketManager();
