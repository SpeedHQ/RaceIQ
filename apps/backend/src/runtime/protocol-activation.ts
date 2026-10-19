import { createConnection, createServer, type Server, type Socket } from "node:net";

const PIPE = "\\\\.\\pipe\\RaceIQ-Protocol";
const MAX_MESSAGE_BYTES = 8192;

/** Accept only exact, credential-free RaceIQ import links; importer validates the embedded service URL again. */
export function parseRaceIqImportLink(value: string): string | null {
  if (value.length > 4096 || /[\r\n\0]/.test(value)) return null;
  try {
    const link = new URL(value);
    if (link.protocol !== "raceiq:" || link.hostname !== "import" || link.port || (link.pathname !== "" && link.pathname !== "/") || link.username || link.password || link.hash || link.searchParams.size !== 1 || !link.searchParams.has("url")) return null;
    const remote = new URL(link.searchParams.get("url")!);
    const lapId = decodeURIComponent(remote.pathname.match(/^\/api\/v1\/laps\/([^/]+)\/import\.zip$/)?.[1] ?? "");
    if (remote.protocol !== "https:" || remote.origin !== "https://raceiq.snazzie.space" || remote.username || remote.password || remote.search || remote.hash || !/^[A-Za-z0-9_-]{1,128}$/.test(lapId)) return null;
    return value;
  } catch {
    return null;
  }
}

export interface ProtocolActivationTransportOptions {
  pipePath?: string;
  platform?: NodeJS.Platform;
}

function transportPath(options: ProtocolActivationTransportOptions): string {
  return options.pipePath ?? PIPE;
}

function canUseTransport(options: ProtocolActivationTransportOptions): boolean {
  return options.pipePath !== undefined || (options.platform ?? process.platform) === "win32";
}

/** Forward a validated activation to an existing instance. */
export async function forwardRaceIqActivation(value: string, options: ProtocolActivationTransportOptions = {}): Promise<boolean> {
  const link = parseRaceIqImportLink(value);
  if (!link || !canUseTransport(options)) return false;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection(transportPath(options));
  let settled = false;
  const finish = (accepted: boolean) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(accepted);
  };
  socket.setTimeout(1000, () => finish(false));
  socket.once("connect", () => socket.end(`${JSON.stringify({ url: link })}\n`));
  socket.once("data", (chunk) => finish(chunk.toString("utf8").trim() === "ok"));
  socket.once("error", () => finish(false));
  socket.once("close", () => finish(false));
  return promise;
}

/** Claim activation IPC before boot; queued dispatch runs after backend readiness. */
export async function startRaceIqActivationBroker(
  dispatch: (url: string) => Promise<void>,
  options: ProtocolActivationTransportOptions = {},
): Promise<{ close(): Promise<void> } | null> {
  if (!canUseTransport(options)) return null;
  const { promise, resolve } = Promise.withResolvers<{ close(): Promise<void> } | null>();
  const server: Server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.on("error", () => socket.destroy());
    let buffer = "";
    let handled = false;
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) { handled = true; socket.end("rejected\n"); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      handled = true;
      let link: string | null = null;
      try {
        const data = JSON.parse(buffer.slice(0, end)) as { url?: unknown };
        if (typeof data.url === "string") link = parseRaceIqImportLink(data.url);
      } catch {}
      if (!link) { socket.end("rejected\n"); return; }
      socket.end("ok\n");
      void Promise.resolve().then(() => dispatch(link!)).catch(() => {
        console.error("[Server] Could not queue protocol activation.");
      });
    });
  });
  server.once("listening", () => resolve({
    close: () => {
      const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
      server.close(() => markClosed());
      return closed;
    },
  }));
  server.once("error", () => resolve(null));
  server.listen(transportPath(options));
  return promise;
}
