/**
 * UDP listener: receives telemetry datagrams from Forza or F1 2025 and dispatches them.
 *
 * Packet flow:
 *   Game (60Hz UDP) -> parsePacket (auto-detects game format)
 *                   -> lapDetector (session/lap/DB)
 *                   -> feedPosition (track calibration, 10Hz)
 *                   -> wsManager.broadcast (WebSocket, 30Hz)
 *
 * The parser auto-detects whether incoming packets are Forza Dash (324 bytes)
 * or F1 2025 format based on packet structure and header signatures.
 */
import { parsePacket } from "./parser";
import { wsManager } from "./ws";
import { processPacket } from "./pipeline";
import { getRunningGame } from "./games/registry";
import { lapDetector } from "./lap-detector";

const MIN_PACKET_LENGTH = 29; // Minimum: F1 header size
const PACKETS_PER_SEC_WINDOW = 1000; // 1-second sliding window for rate display

class UdpListener {
  private _droppedPackets = 0;
  private _totalPackets = 0;
  private _receiving = false;
  private _packetsInWindow = 0;
  private _packetsPerSec = 0;
  // @ts-ignore — used for packet rate tracking (written but read by interval timer)
  private _lastWindowStart = Date.now();
  private _socket: { stop(): void } | null = null;
  private _port = 5301;
  private _hostname = "0.0.0.0";

  get droppedPackets(): number {
    return this._droppedPackets;
  }

  get packetsPerSec(): number {
    return this._packetsPerSec;
  }

  get receiving(): boolean {
    return this._receiving;
  }

  get totalPackets(): number {
    return this._totalPackets;
  }

  get port(): number {
    return this._port;
  }

  get hostname(): string {
    return this._hostname;
  }

  async start(port: number = 5301, hostname: string = "0.0.0.0"): Promise<void> {
    this._port = port;
    this._hostname = hostname;
    console.log(`[UDP] Starting listener on ${hostname}:${port}...`);

    // Use dgram for socket buffer tuning — Bun.udpSocket doesn't expose setsockopt
    const dgram = require("dgram");
    const sock = dgram.createSocket("udp4");
    sock.on("message", (buf: Buffer) => this.handlePacket(buf));
    await new Promise<void>((resolve, reject) => {
      sock.bind(port, hostname, () => {
        try {
          // F1 sends ~10 packet types per frame in bursts. The default 8KB OS buffer
          // overflows during bursts causing consistent packet loss (~20% drops).
          // 64MB ensures the OS can queue packets while the event loop processes them.
          sock.setRecvBufferSize(64 * 1024 * 1024);
          console.log(`[UDP] Receive buffer set to 64MB`);
        } catch {}
        resolve();
      });
      sock.on("error", reject);
    });
    this._socket = { stop: () => sock.close() };

    console.log(`[UDP] Listening on ${hostname}:${port}`);

    // Update packets/sec every second
    setInterval(() => {
      this._packetsPerSec = this._packetsInWindow;
      this._packetsInWindow = 0;
      this._lastWindowStart = Date.now();

      // Mark as not receiving if no packets in last second
      if (this._packetsPerSec === 0 && this._receiving) {
        this._receiving = false;
      }

      // Broadcast full server status to clients (replaces REST polling)
      const runningGame = getRunningGame();
      const session = lapDetector.session;
      wsManager.broadcastStatus({
        udpPps: this._packetsPerSec,
        isRaceOn: this._receiving,
        droppedPackets: this._droppedPackets,
        udpPort: this._port,
        detectedGame: runningGame
          ? { id: runningGame.id, name: runningGame.shortName }
          : null,
        currentSession: session
          ? { id: session.sessionId, carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal }
          : null,
      });

      if (this._packetsPerSec > 0) {
        console.log(`[UDP] total=${this._totalPackets} dropped=${this._droppedPackets} pps=${this._packetsPerSec}`);
      }
    }, PACKETS_PER_SEC_WINDOW);
  }

  private handlePacket(buf: Buffer): void {
    this._totalPackets++;
    this._packetsInWindow++;

    // Validate packet length
    if (buf.length < MIN_PACKET_LENGTH) {
      this._droppedPackets++;
      return;
    }

    // Returns null when game is paused/in menus (IsRaceOn == 0)
    const packet = parsePacket(buf);
    if (!packet) {
      return;
    }

    this._receiving = true;
    processPacket(packet);
  }

  stop(): void {
    if (this._socket) {
      this._socket.stop();
      this._socket = null;
      console.log("[UDP] Listener stopped");
    }
  }

  async restart(port: number, hostname?: string): Promise<void> {
    this.stop();
    this._droppedPackets = 0;
    this._totalPackets = 0;
    this._receiving = false;
    this._packetsInWindow = 0;
    this._packetsPerSec = 0;
    await this.start(port, hostname ?? this._hostname);
  }
}

export const udpListener = new UdpListener();
