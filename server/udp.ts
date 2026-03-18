import { parsePacket } from "./parser";
import { wsManager } from "./ws";
import { lapDetector } from "./lap-detector";
import { feedPosition } from "./track-calibration";
import { getTrackOutlineByOrdinal } from "../shared/track-outlines/index";

const MIN_PACKET_LENGTH = 324; // Dash format minimum
const PACKETS_PER_SEC_WINDOW = 1000; // 1 second window for rate calculation

class UdpListener {
  private _droppedPackets = 0;
  private _totalPackets = 0;
  private _receiving = false;
  private _packetsInWindow = 0;
  private _packetsPerSec = 0;
  private _lastWindowStart = Date.now();
  private _socket: ReturnType<typeof Bun.udpSocket> | null = null;
  private _port = 5300;
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

  async start(port: number = 5300, hostname: string = "0.0.0.0"): Promise<void> {
    this._port = port;
    this._hostname = hostname;
    console.log(`[UDP] Starting listener on ${hostname}:${port}...`);

    this._socket = await Bun.udpSocket({
      port,
      hostname,
      socket: {
        data: (_socket, buf, _port, _addr) => {
          this.handlePacket(Buffer.from(buf));
        },
      },
    });

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

    // Parse the packet (returns null if IsRaceOn == 0)
    const packet = parsePacket(buf);
    if (!packet) {
      return;
    }

    this._receiving = true;

    // Feed to lap detector (handles session + lap boundary detection + DB storage)
    lapDetector.feed(packet);

    // Feed position for track calibration (every 6th packet = ~10Hz)
    if (this._totalPackets % 6 === 0) {
      const session = lapDetector.session;
      if (session && session.trackOrdinal) {
        const outline = getTrackOutlineByOrdinal(session.trackOrdinal);
        if (outline) {
          feedPosition(
            session.trackOrdinal,
            { x: packet.PositionX, z: packet.PositionZ },
            packet.LapNumber,
            outline
          );
        }
      }
    }

    // Broadcast to WebSocket clients (handles 30Hz throttle internally)
    wsManager.broadcast(packet);
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
