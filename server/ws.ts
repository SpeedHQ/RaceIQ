import type { ServerWebSocket } from "bun";
import type { TelemetryPacket } from "../shared/types";

export interface WSData {
  createdAt: number;
}

const GRIP_MAX_SAMPLES = 600; // 60s at 10 samples/sec

export interface GripHistoryData {
  fl: number[];
  fr: number[];
  rl: number[];
  rr: number[];
}

class WebSocketManager {
  private clients = new Set<ServerWebSocket<WSData>>();
  private packetCount = 0;
  private shouldBroadcast = true; // Toggle every packet for 30Hz throttle
  private gripSampleCounter = 0;
  private gripHistory: GripHistoryData = { fl: [], fr: [], rl: [], rr: [] };

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

  /**
   * Broadcast a parsed telemetry packet to all connected clients.
   * Throttled to ~30Hz by skipping every other packet (game sends at 60Hz).
   */
  broadcast(packet: TelemetryPacket): void {
    this.packetCount++;

    // Sample grip data at ~10Hz (every 6th packet from 60Hz)
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
