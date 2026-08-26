import dgram from "node:dgram";
import { encodeAccBroadcastRegistration, parseAccBroadcastMessage } from "./broadcast-protocol";
import { accBroadcastState, AccBroadcastState } from "./broadcast-state";

type DatagramSocket = {
  connect(port: number, address: string, callback?: () => void): void;
  send(message: Uint8Array, callback?: (error: Error | null) => void): void;
  on(event: string, listener: (message: Buffer) => void): void;
  close(callback?: () => void): void;
};

export interface AccBroadcastClientOptions {
  host?: string;
  port?: number;
  displayName?: string;
  connectionPassword?: string;
  commandPassword?: string;
  realtimeIntervalMs?: number;
  state?: AccBroadcastState;
  socketFactory?: () => DatagramSocket;
}

export class AccBroadcastClient {
  private readonly options: Required<Omit<AccBroadcastClientOptions, "state" | "socketFactory">> & Pick<AccBroadcastClientOptions, "state" | "socketFactory">;
  private socket: DatagramSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private registered = false;
  private generation = 0;
  private stopped = false;

  constructor(options: AccBroadcastClientOptions = {}) {
    this.options = {
      host: options.host ?? process.env.ACC_BROADCAST_HOST ?? "127.0.0.1",
      port: options.port ?? Number(process.env.ACC_BROADCAST_PORT ?? 9000),
      displayName: options.displayName ?? "RaceIQ",
      connectionPassword: options.connectionPassword ?? process.env.ACC_BROADCAST_PASSWORD ?? "",
      commandPassword: options.commandPassword ?? process.env.ACC_BROADCAST_COMMAND_PASSWORD ?? "",
      realtimeIntervalMs: options.realtimeIntervalMs ?? 100,
      state: options.state,
      socketFactory: options.socketFactory,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.connectPromise) {
      await this.connectPromise;
      if (this.socket && !this.registered) this.sendRegistration(this.socket);
      return;
    }
    if (this.socket) {
      if (!this.registered) this.sendRegistration(this.socket);
      return;
    }
    const generation = ++this.generation;
    const socket = this.options.socketFactory?.() ?? dgram.createSocket("udp4");
    this.socket = socket;
    const state = this.options.state ?? accBroadcastState;
    socket.on("message", (payload) => {
      const message = parseAccBroadcastMessage(payload);
      if (!message) return;
      if (message.type === "registration-result") {
        if (message.success && this.socket === socket && this.generation === generation) this.registered = true;
        return;
      }
      state.apply(message);
    });
    socket.on("error", () => {
      if (!this.stopped) this.stop().catch(() => {});
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.registered = false;
      if (!this.stopped) this.generation += 1;
    });
    const connect = new Promise<void>((resolve) => socket.connect(this.options.port, this.options.host, resolve));
    const pending = connect.then(() => {
      if (this.stopped || this.socket !== socket || this.generation !== generation) {
        socket.close();
        return;
      }
      this.sendRegistration(socket);
    }).finally(() => {
      if (this.connectPromise) this.connectPromise = null;
    });
    this.connectPromise = pending;
    return pending;
  }

  private sendRegistration(socket: DatagramSocket): void {
    socket.send(encodeAccBroadcastRegistration(this.options.displayName, this.options.connectionPassword, this.options.realtimeIntervalMs, this.options.commandPassword));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    this.registered = false;
    (this.options.state ?? accBroadcastState).reset();
    if (!socket) return;
    await new Promise<void>((resolve) => socket.close(resolve));
  }
}

export const accBroadcastClient = new AccBroadcastClient();
