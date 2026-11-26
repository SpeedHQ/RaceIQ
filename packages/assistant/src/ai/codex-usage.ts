import { z } from "zod";
import { APP_VERSION } from "@raceiq/shared/platform/runtime/app-version";

const quotaWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullish().transform((value) => value ?? null),
  resetsAt: z.number().int().min(0).max(253402300799).nullish().transform((value) => value ?? null),
});
const bucketIdentity = z.object({ limitId: z.string().nullish() });
const codexBucket = bucketIdentity.extend({
  primary: quotaWindow.nullish(),
  secondary: quotaWindow.nullish(),
});
const quotaReply = z.object({
  rateLimits: z.unknown().optional(),
  rateLimitsByLimitId: z.object({ codex: z.unknown().optional() }).nullish(),
});
const accountReply = z.object({ account: z.object({ type: z.string() }).nullable() });
const rpcMessage = z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() });

export type CodexUsage =
  | { status: "available"; windows: z.output<typeof quotaWindow>[] }
  | { status: "cli_missing" | "sign_in_required" | "quota_unavailable" | "read_failed" };

function parseQuota(result: unknown): CodexUsage {
  const { rateLimits, rateLimitsByLimitId } = quotaReply.parse(result);
  const keyed = rateLimitsByLimitId?.codex;
  const snapshot = keyed === undefined ? rateLimits : keyed;
  if (bucketIdentity.parse(snapshot).limitId !== "codex") {
    return { status: keyed === undefined ? "quota_unavailable" : "read_failed" };
  }
  const { primary, secondary } = codexBucket.parse(snapshot);
  const windows = [primary, secondary].filter((window) => window != null);
  return windows.length ? { status: "available", windows } : { status: "quota_unavailable" };
}

async function readUsage(): Promise<CodexUsage> {
  const { HOME, PATH, CODEX_HOME, LANG, TMPDIR } = process.env;
  const executable = PATH && Bun.which("codex", { PATH });
  if (!executable) return { status: "cli_missing" };
  const child = Bun.spawn([executable, "app-server", "--listen", "stdio://"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { HOME, PATH, CODEX_HOME, LANG, TMPDIR },
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const timer = setTimeout(() => child.kill(9), 10_000);
  let pending = "";
  let bytesRead = 0;

  async function send(message: object) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    await child.stdin.flush();
  }

  async function readReply(id: number): Promise<unknown> {
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const message = rpcMessage.safeParse(JSON.parse(line));
        if (!message.success || message.data.id !== id) continue;
        if (message.data.error !== undefined || message.data.result === undefined) throw new Error("Codex RPC failed");
        return message.data.result;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Codex closed the RPC stream");
      bytesRead += chunk.value.byteLength;
      if (bytesRead > 1024 * 1024) throw new Error("Codex RPC exceeded the response limit");
      pending += decoder.decode(chunk.value, { stream: true });
    }
  }

  try {
    await send({ id: 1, method: "initialize", params: { clientInfo: { name: "raceiq", title: "RaceIQ", version: APP_VERSION } } });
    await readReply(1);
    await send({ method: "initialized" });
    await send({ id: 2, method: "account/read", params: { refreshToken: false } });
    const { account } = accountReply.parse(await readReply(2));
    if (account?.type !== "chatgpt") return { status: "sign_in_required" };
    await send({ id: 3, method: "account/rateLimits/read" });
    return parseQuota(await readReply(3));
  } finally {
    clearTimeout(timer);
    child.kill(9);
    await reader.cancel().catch(() => undefined);
    await child.exited;
  }
}

let inFlight: Promise<CodexUsage> | undefined;

export function readCodexUsage(): Promise<CodexUsage> {
  return inFlight ??= readUsage().catch((): CodexUsage => ({ status: "read_failed" })).finally(() => { inFlight = undefined; });
}
