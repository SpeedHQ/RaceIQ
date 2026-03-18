import { parsePacket } from "./parser";
import { wsManager } from "./ws";
import { lapDetector } from "./lap-detector";

const PACKET_LENGTH = 331;
const PACKETS_PER_SEC_WINDOW = 1000; // 1 second window for rate calculation

class UdpListener {
  private _droppedPackets = 0;
  private _totalPackets = 0;
  private _receiving = false;
  private _packetsInWindow = 0;
  private _packetsPerSec = 0;
  private _lastWindowStart = Date.now();
  private _socket: ReturnType<typeof Bun.udpSocket> | null = null;

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

  async start(port: number = 5300): Promise<void> {
    console.log(`[UDP] Starting listener on port ${port}...`);

    this._socket = await Bun.udpSocket({
      port,
      socket: {
        data: (_socket, buf, _port, _addr) => {
          this.handlePacket(Buffer.from(buf));
        },
      },
    });

    console.log(`[UDP] Listening on port ${port}`);

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
    if (buf.length !== PACKET_LENGTH) {
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
}

export const udpListener = new UdpListener();
