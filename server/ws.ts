import type { ServerWebSocket } from "bun";
import type { TelemetryPacket } from "../shared/types";

export interface WSData {
  createdAt: number;
}

class WebSocketManager {
  private clients = new Set<ServerWebSocket<WSData>>();
  private packetCount = 0;
  private shouldBroadcast = true; // Toggle every packet for 30Hz throttle

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

  /**
   * Broadcast a parsed telemetry packet to all connected clients.
   * Throttled to ~30Hz by skipping every other packet (game sends at 60Hz).
   */
  broadcast(packet: TelemetryPacket): void {
    this.packetCount++;

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
