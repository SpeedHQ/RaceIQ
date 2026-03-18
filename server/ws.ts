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
import type { TelemetryPacket } from "../shared/types";

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
  private shouldBroadcast = true; // Toggled every packet — true = send, false = skip
  private gripSampleCounter = 0; // Counts to 6 for 10Hz history sampling
  private gripHistory: GripHistoryData = { fl: [], fr: [], rl: [], rr: [] };
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

  addClient(ws: ServerWebSocket<WSData>): void {
    this.clients.add(ws);
    console.log(
      `[WS] Client connected. Total: ${this.clients.size}`
    );
  }

  removeClient(ws: ServerWebSocket<WSData>): void {
    this.clients.delete(ws);
    console.log(
      `[WS] Client disconnected. Total: ${this.clients.size}`
    );
  }

  getGripHistory(): GripHistoryData {
    return this.gripHistory;
  }

  getTelemetryHistory(): TelemetryHistoryData {
    return this.telemetryHistory;
  }

  /**
   * Broadcast a parsed telemetry packet to all connected clients.
   * Throttled to ~30Hz by skipping every other packet (game sends at 60Hz).
   */
  broadcast(packet: TelemetryPacket): void {
    this.packetCount++;

    // Sample telemetry data at ~10Hz (every 6th packet from 60Hz)
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
      t.throttle.push(packet.Accel / 255); // 0-255 -> 0-1
      t.brake.push(packet.Brake / 255);
      t.speed.push(packet.Speed * 2.23694); // m/s -> mph
      if (t.throttle.length > GRIP_MAX_SAMPLES) { t.throttle.shift(); t.brake.shift(); t.speed.shift(); }
    }

    // Skip every other packet for 30Hz throttle
    this.shouldBroadcast = !this.shouldBroadcast;
    if (!this.shouldBroadcast) return;

    if (this.clients.size === 0) return;

    const json = JSON.stringify(packet);
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
