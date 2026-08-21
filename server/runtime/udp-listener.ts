/**
 * UDP listener: receives telemetry datagrams from Forza or F1 2025 and dispatches them.
 *
 * Packet flow:
 *   Game (60Hz UDP) -> parsePacket (auto-detects game format)
 *                   -> lapDetector (session/lap/DB)
 *                   -> feedCalibrationPosition (track calibration, 10Hz)
 *                   -> wsManager.broadcast (WebSocket, 30Hz)
 *
 * The parser auto-detects whether incoming packets are Forza Dash (324 bytes)
 * or F1 2025 format based on packet structure and header signatures.
 */
import { resolve } from "node:path";
import { parsePacket } from "../games/packet-dispatch";
import { wsManager } from "./websocket-manager";
import { processPacket, flushSessionRecorderBuffer, lapDetector, noteSourceLifecycle } from "../telemetry/live-pipeline";
import { getRunningGame } from "../games/registry";
import { SessionRecorder } from "../session-capture/recorder";
import type { GameId } from "../../shared/games/ids";

const MIN_PACKET_LENGTH = 29; // Minimum: F1 header size
const PACKETS_PER_SEC_WINDOW = 1000; // 1-second sliding window for rate display

export interface UdpListenerDependencies {
  parsePacket: typeof parsePacket;
  processPacket: typeof processPacket;
  noteSourceLifecycle: typeof noteSourceLifecycle;
}

const DEFAULT_DEPENDENCIES: UdpListenerDependencies = {
  parsePacket,
  processPacket,
  noteSourceLifecycle,
};

export class UdpListener {
  private _droppedPackets = 0;
  private _totalPackets = 0;
  private _receiving = false;
  private _packetsInWindow = 0;
  private _packetsPerSec = 0;
  private _socket: { stop(): Promise<void> } | null = null;
  private _port = 5301;
  private _hostname = "0.0.0.0";
  private _recorder: SessionRecorder | null = null;
  private _recordingGameId: GameId | null = null;
  private _lastDetectedGame: ReturnType<typeof getRunningGame> = null;
  private _lastRaceOn = false;
  private _lastWsPacketCount = 0;
  private _lastStatusAt = performance.now();
  private _statusTimer: ReturnType<typeof setInterval> | null = null;
  private _timedOut = false;
  private _activeSourceGame: GameId | null = null;
  private _timedOutSourceGame: GameId | null = null;
  private _activeSourceSessionId: number | null = null;
  private _timedOutSourceSessionId: number | null = null;
  private readonly dependencies: UdpListenerDependencies;
  private _operationQueue = Promise.resolve();
  private _stopping = false;

  constructor(dependencies: UdpListenerDependencies = DEFAULT_DEPENDENCIES) {
    this.dependencies = dependencies;
  }

  private _enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this._operationQueue;
    let release!: () => void;
    this._operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }

  protected _enqueuePacket(sourceFrame: Buffer): Promise<void> {
    if (this._stopping) return Promise.resolve();
    return this._enqueueOperation(() => this.handlePacket(sourceFrame)).catch((error) => {
      console.error("[UDP] Packet processing failed:", error);
    });
  }

  get droppedPackets(): number {
    return this._droppedPackets;
  }

  get packetsPerSec(): number {
    return this._packetsPerSec;
  }

  get receiving(): boolean {
    return this._receiving;
  }

  get port(): number {
    return this._port;
  }

  /**
   * Pin a recording gameId. When set, `start()` opens a timestamped .bin file
   * under test/artifacts/sessions/ and every incoming datagram is appended to it
   * (in addition to the normal parse → pipeline → DB/WS flow). Mirrors how the
   * AccSharedMemoryReader/AcEvoSharedMemoryReader constructors create their
   * .bin files when `recordingEnabled=true`. Used by `dev:dump:fm` / `dev:dump:f1`.
   */
  setRecordingGameId(gameId: GameId | null): void {
    this._recordingGameId = gameId;
  }

  async start(port: number = 5301, hostname: string = "0.0.0.0"): Promise<void> {
    this._stopping = false;
    this._port = port;
    this._hostname = hostname;
    console.log(`[UDP] Starting listener on ${hostname}:${port}...`);

    if (this._recordingGameId && !this._recorder) {
      const dir = resolve(process.cwd(), "test", "artifacts", "sessions");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = resolve(dir, `${this._recordingGameId}-${timestamp}.bin`);
      this._recorder = new SessionRecorder();
      this._recorder.start(filePath);
    }

    // Use dgram for socket buffer tuning — Bun.udpSocket doesn't expose setsockopt
    const dgram = require("node:dgram");
    const sock = dgram.createSocket("udp4");
    sock.on("message", (sourceFrame: Buffer) => void this._enqueuePacket(sourceFrame));
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
    this._socket = {
      stop: () => new Promise<void>((resolve, reject) => {
        sock.close((error?: Error) => error ? reject(error) : resolve());
      }),
    };

    console.log(`[UDP] Listening on ${hostname}:${port}`);
    await this.dependencies.noteSourceLifecycle({
      kind: "start",
      timestampMs: Date.now(),
      eventId: `udp-start:${hostname}:${port}`,
    });

    // Update packets/sec every second. Own the handle so restart replaces,
    // rather than stacks, status/flush loops.
    clearInterval(this._statusTimer ?? undefined);
    this._lastStatusAt = performance.now();
    this._lastWsPacketCount = wsManager.packetCount;
    this._statusTimer = setInterval(() => {
      const statusAt = performance.now();
      const elapsedMs = Math.max(1, statusAt - this._lastStatusAt);
      this._lastStatusAt = statusAt;
      this._packetsPerSec = Math.round((this._packetsInWindow * 1000) / elapsedMs);
      this._packetsInWindow = 0;

      // Flush the session recorder's in-memory write buffer so rawByteOffset
      // stored on lap rows always has corresponding bytes on disk. Without
      // this, an abrupt termination leaves lap offsets pointing past EOF and
      // telemetry disappears from the analyse view.
      flushSessionRecorderBuffer();

      // Only accepted UDP telemetry owns this timeout. Raw invalid/menu traffic
      // cannot keep a previously active source alive.
      if (this._packetsPerSec === 0) {
        void this._enqueueOperation(async () => {
          if (
            this._packetsInWindow !== 0 ||
            !this._receiving ||
            !this._activeSourceGame ||
            this._activeSourceSessionId === null
          ) {
            return;
          }
          const gameId = this._activeSourceGame;
          const sessionId = this._activeSourceSessionId;
          this._receiving = false;
          this._timedOut = true;
          this._timedOutSourceGame = gameId;
          this._timedOutSourceSessionId = sessionId;
          try {
            await this.dependencies.noteSourceLifecycle(
              {
                kind: "timeout",
                timestampMs: Date.now(),
                eventId: `udp-timeout:${Date.now()}`,
              },
              { kind: "udp", gameId, sessionId },
            );
          } catch (error) {
            console.error("[UDP] Timeout lifecycle failed:", error);
          }
        }).catch((error) => {
          console.error("[UDP] Timeout processing failed:", error);
        });
      }

      // Stream-wide activity: count packets handed to wsManager from any
      // source (UDP, ACC SHM, AC Evo SHM). isRaceOn must reflect all sources,
      // not just UDP — otherwise shared-memory games show "Waiting" forever.
      const wsCount = wsManager.packetCount;
      const telemetryPps = Math.round(((wsCount - this._lastWsPacketCount) * 1000) / elapsedMs);
      this._lastWsPacketCount = wsCount;
      const raceOn = this._receiving || telemetryPps > 0;

      // Broadcast full server status to clients (replaces REST polling)
      const runningGame = getRunningGame();
      const session = lapDetector.session;

      // Log game detection changes and finalize session if game disconnects
      if (this._lastDetectedGame?.id !== runningGame?.id) {
        if (runningGame) {
          console.log(`[Game] ${runningGame.displayName} detected (state: ${runningGame.id})`);
        } else {
          console.log("[Game] state change to null");
          // Finalize session immediately when game disconnects
          void lapDetector.finalizeCurrentSession("source-disconnected").catch((error) => {
            console.error("[Live Telemetry] Session finalization failed:", error);
          });
        }
      }
      this._lastDetectedGame = runningGame;

      // Log race state changes
      if (!this._lastRaceOn && raceOn) {
        console.log("[State] Race on");
      } else if (this._lastRaceOn && !raceOn) {
        console.log("[State] Race off");
      }
      this._lastRaceOn = raceOn;

      wsManager.broadcastStatus({
        udpPps: this._packetsPerSec,
        telemetryPps,
        isRaceOn: raceOn,
        droppedPackets: this._droppedPackets,
        udpPort: this._port,
        detectedGame: runningGame ? { id: runningGame.id, name: runningGame.shortName } : null,
        currentSession: session ? { id: session.sessionId, carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal } : null,
      });

      if (this._packetsPerSec > 0) {
        console.log(`[UDP] total=${this._totalPackets} dropped=${this._droppedPackets} pps=${this._packetsPerSec}`);
      }
    }, PACKETS_PER_SEC_WINDOW);
  }

  protected async handlePacket(sourceFrame: Buffer): Promise<void> {
    this._totalPackets++;

    if (sourceFrame.length < MIN_PACKET_LENGTH) {
      this._droppedPackets++;
      return;
    }

    // Append raw datagrams to the dump BEFORE parsing so recordings preserve
    // the exact wire format (including any packets parsePacket would skip).
    this._recorder?.writeRecord(sourceFrame);

    // Returns null when game is paused/in menus (IsRaceOn == 0)
    const packet = this.dependencies.parsePacket(sourceFrame);
    if (!packet) {
      return;
    }

    this._packetsInWindow++;
    const gameId = packet.gameId;
    if (this._timedOut) {
      const timedOutGame = this._timedOutSourceGame;
      const timedOutSessionId = this._timedOutSourceSessionId;
      this._timedOut = false;
      this._timedOutSourceGame = null;
      this._timedOutSourceSessionId = null;
      if (timedOutGame === gameId && timedOutSessionId !== null) {
        await this.dependencies.noteSourceLifecycle(
          {
            kind: "reconnect",
            timestampMs: Date.now(),
            eventId: `udp-reconnect:${this._totalPackets}`,
          },
          { kind: "udp", gameId, sessionId: timedOutSessionId },
        );
      }
    }

    this._activeSourceGame = gameId;
    this._receiving = true;
    await this.dependencies.processPacket(packet, sourceFrame);
    const session = lapDetector.session;
    this._activeSourceSessionId = session?.gameId === gameId ? session.sessionId : null;
  }

  async stop(): Promise<void> {
    this._stopping = true;
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try {
        await socket.stop();
      } catch (error) {
        console.error("[UDP] Listener stop failed:", error);
      }
      console.log("[UDP] Listener stopped");
    }
    if (this._statusTimer) {
      clearInterval(this._statusTimer);
      this._statusTimer = null;
    }

    await this._operationQueue;
    const source = this._activeSourceGame && this._activeSourceSessionId !== null
      ? { kind: "udp" as const, gameId: this._activeSourceGame, sessionId: this._activeSourceSessionId }
      : undefined;
    try {
      await this.dependencies.noteSourceLifecycle(
        {
          kind: "stop",
          timestampMs: Date.now(),
          eventId: `udp-stop:${this._hostname}:${this._port}`,
        },
        source,
      );
    } catch (error) {
      console.error("[UDP] Stop lifecycle failed:", error);
    }
    if (this._recorder) {
      await this._recorder.stop();
      this._recorder = null;
    }
  }

  async restart(port: number, hostname?: string): Promise<void> {
    await this.stop();
    this._droppedPackets = 0;
    this._totalPackets = 0;
    this._receiving = false;
    this._timedOut = false;
    this._activeSourceGame = null;
    this._timedOutSourceGame = null;
    this._activeSourceSessionId = null;
    this._timedOutSourceSessionId = null;
    this._packetsInWindow = 0;
    this._packetsPerSec = 0;
    await this.start(port, hostname ?? this._hostname);
  }
}

export const udpListener = new UdpListener();
