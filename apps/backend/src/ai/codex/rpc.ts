/** Private stdio boundary; never expose this interface as an application API. */
export interface CodexTransport {
  stdout: ReadableStream<Uint8Array>;
  /** Flush one complete frame. Implementations must bound their own IO waits. */
  write(line: string): void | Promise<void>;
  /** Terminate only the owned child, with escalation, and await its exit. */
  close(): void | Promise<void>;
}

export class CodexRpcError extends Error {
  readonly name = "CodexRpcError";

  constructor(
    readonly kind: "remote" | "closed" | "protocol" | "timeout" | "cancelled" | "overloaded",
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRpcId(value: unknown): value is number | string {
  return (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && value.length > 0);
}

export class CodexRpcConnection {
  readonly closed: Promise<CodexRpcError>;
  #onClosed!: (error: CodexRpcError) => void;
  readonly #transport: CodexTransport;
  readonly #maxFrameBytes: number;
  readonly #onNotification?: (method: string, params: unknown) => void;
  #nextId = 0;
  #terminalError?: CodexRpcError;
  #shutdownError?: CodexRpcError;
  #closing?: Promise<void>;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: CodexRpcError): void }>();

  constructor(transport: CodexTransport, options: { maxFrameBytes?: number; onNotification?: (method: string, params: unknown) => void } = {}) {
    this.closed = new Promise((resolve) => {
      this.#onClosed = resolve;
    });
    this.#transport = transport;
    this.#maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.#onNotification = options.onNotification;
    void this.#read();
  }

  /** Abort/deadline terminates this connection; active turns need higher-level interruption. */
  request(method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const cancel = () => this.#stop(new CodexRpcError("cancelled", "Codex RPC cancelled"));
    if (options.signal?.aborted) cancel();
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#pending.size >= 64) return Promise.reject(new CodexRpcError("overloaded", "Codex pending RPC limit exceeded"));
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      const timer = setTimeout(() => this.#stop(new CodexRpcError("timeout", "Codex RPC deadline exceeded")), options.timeoutMs ?? 10_000);
      options.signal?.addEventListener("abort", cancel, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      };
      this.#pending.set(id, {
        resolve(value) {
          cleanup();
          resolve(value);
        },
        reject(error) {
          cleanup();
          reject(error);
        },
      });
      void Promise.resolve()
        .then(() => {
          if (!this.#terminalError) return this.#transport.write(JSON.stringify({ id, method, params }) + "\n");
        })
        .catch(() => this.#stop(new CodexRpcError("closed", "Codex connection write failed")));
    });
  }

  async close(): Promise<void> {
    this.#stop(new CodexRpcError("closed", "Codex connection closed"));
    await this.#closing;
    if (this.#shutdownError) throw this.#shutdownError;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#terminalError) throw this.#terminalError;
    try {
      await this.#transport.write(JSON.stringify({ method, params }) + "\n");
    } catch {
      this.#stop(new CodexRpcError("closed", "Codex connection write failed"));
      throw this.#terminalError;
    }
  }

  #stop(error: CodexRpcError): void {
    if (this.#terminalError) return;
    this.#terminalError = error;
    this.#onClosed(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#closing = Promise.resolve()
      .then(() => this.#transport.close())
      .catch(() => {
        this.#shutdownError = new CodexRpcError("closed", "Codex transport shutdown failed");
      });
  }

  async #read(): Promise<void> {
    try {
      let buffer = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for await (const chunk of this.#transport.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          if (this.#terminalError) return;
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          if (Buffer.byteLength(line) > this.#maxFrameBytes) throw new Error("Frame limit");
          const message: unknown = JSON.parse(line);
          if (!isRecord(message)) throw new Error("Invalid envelope");
          if (Object.hasOwn(message, "method")) {
            if (typeof message.method !== "string" || !message.method || "result" in message || "error" in message) throw new Error("Invalid method envelope");
            if (!Object.hasOwn(message, "id")) this.#onNotification?.(message.method, message.params);
            else {
              if (!isRpcId(message.id)) throw new Error("Invalid request id");
              await this.#transport.write(
                JSON.stringify({
                  id: message.id,
                  error: {
                    code: -32601,
                    message: "No server requests are authorized on this connection",
                  },
                }) + "\n",
              );
            }
            continue;
          }
          if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) throw new Error("Invalid response id");
          if ("result" in message === "error" in message) throw new Error("Invalid response envelope");
          const request = this.#pending.get(message.id);
          if ("error" in message) {
            if (!isRecord(message.error) || typeof message.error.code !== "number" || !Number.isSafeInteger(message.error.code)) throw new Error("Invalid RPC error");
            request?.reject(new CodexRpcError("remote", "Codex RPC request failed", message.error.code));
          } else request?.resolve(message.result);
          this.#pending.delete(message.id);
        }
        if (Buffer.byteLength(buffer) > this.#maxFrameBytes) throw new Error("Frame limit");
      }
      buffer += decoder.decode();
      if (buffer.trim()) throw new Error("Truncated frame");
    } catch {
      this.#stop(new CodexRpcError("protocol", "Invalid Codex RPC stream"));
    } finally {
      this.#stop(new CodexRpcError("closed", "Codex connection closed"));
    }
  }
}
