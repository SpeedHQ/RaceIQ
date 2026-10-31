import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRpcConnection } from "./rpc";

export type CodexGenerationInput = {
  /** Trusted backend-owned executable prefix; never accept argv from a model. */
  command: readonly string[];
  model: string;
  prompt: string;
  schema?: object;
  effort?: string;
  requestedOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CodexGenerationResult = {
  text: string;
  status: "completed";
  runtimeVersion: "0.164.0";
  model: string;
  latencyMs: number;
  firstContentMs: number | null;
  budget: { requestedOutputTokens: number | null; effectiveOutputTokens: null; supported: false };
  usage: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningOutputTokens: number | null; costUsd: null };
};

export class CodexRuntimeError extends Error {
  readonly name = "CodexRuntimeError";
  readonly code: "unsupported-runtime" | "not-signed-in" | "unsafe-runtime" | "generation-failed" | "cancelled" | "cli-unavailable";
  constructor(
    code: CodexRuntimeError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const DISABLED_FEATURES = [
  "shell_tool",
  "shell_snapshot",
  "apps",
  "plugins",
  "hooks",
  "multi_agent",
  "js_repl",
  "browser_use",
  "computer_use",
  "image_generation",
  "view_image",
  "sleep_tool",
  "skill_search",
  "tool_suggest",
  "code_mode_host",
  "incremental_tools",
];
const BASE_OVERRIDES = [
  'model_provider="openai"',
  "mcp_servers={}",
  'sandbox_mode="read-only"',
  'approval_policy="never"',
  'web_search="disabled"',
  "project_doc_max_bytes=0",
  'history.persistence="none"',
  ...DISABLED_FEATURES.map((name) => `features.${name}=false`),
];

function connect(command: readonly string[], cwd: string, overrides = BASE_OVERRIDES, onNotification?: (method: string, params: unknown) => void): CodexRpcConnection {
  const child = Bun.spawn([...command, ...overrides.flatMap((value) => ["-c", value]), "app-server"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
  });
  return new CodexRpcConnection(
    {
      stdout: child.stdout,
      async write(line) {
        child.stdin.write(line);
        await child.stdin.flush();
      },
      async close() {
        child.stdin.end();
        const terminate = setTimeout(() => child.kill("SIGTERM"), 1000);
        const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
        try {
          await child.exited;
        } finally {
          clearTimeout(terminate);
          clearTimeout(kill);
        }
      },
    },
    { onNotification },
  );
}

async function initialize(connection: CodexRpcConnection): Promise<void> {
  await connection.request("initialize", { clientInfo: { name: "raceiq", version: "0.0.1" }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } });
  await connection.notify("initialized");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function requireChatGptAccount(connection: CodexRpcConnection): Promise<void> {
  const response = await connection.request("account/read", { refreshToken: false });
  if (!isRecord(response) || !isRecord(response.account) || response.account.type !== "chatgpt") {
    throw new CodexRuntimeError("not-signed-in", "Sign in to Codex with ChatGPT before using this provider.");
  }
}

async function requireSafeFeatures(connection: CodexRpcConnection): Promise<void> {
  const response = await connection.request("experimentalFeature/list", { limit: 250 });
  if (!isRecord(response) || !Array.isArray(response.data) || response.nextCursor) {
    throw new CodexRuntimeError("unsafe-runtime", "Codex capability inventory is incomplete.");
  }
  const reported = new Set<string>();
  for (const feature of response.data) {
    if (!isRecord(feature) || typeof feature.name !== "string" || typeof feature.enabled !== "boolean" || (DISABLED_FEATURES.includes(feature.name) && feature.enabled)) {
      throw new CodexRuntimeError("unsafe-runtime", "Codex reports an excluded capability enabled.");
    }
    reported.add(feature.name);
  }
  if (DISABLED_FEATURES.some((name) => name !== "shell_snapshot" && !reported.has(name))) throw new CodexRuntimeError("unsafe-runtime", "Codex capability metadata is incomplete.");
}

async function inventory(connection: CodexRpcConnection, threadId?: string): Promise<string[]> {
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await connection.request("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly", ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}) });
    if (!isRecord(response) || !Array.isArray(response.data)) throw new CodexRuntimeError("unsafe-runtime", "Codex MCP inventory is unavailable.");
    for (const server of response.data) {
      if (!isRecord(server) || typeof server.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(server.name) || !isRecord(server.tools) || (threadId && Object.keys(server.tools).length))
        throw new CodexRuntimeError("unsafe-runtime", "Codex MCP configuration cannot be isolated.");
      names.add(server.name);
    }
    if (response.nextCursor == null) return [...names];
    if (typeof response.nextCursor !== "string" || !response.nextCursor) break;
    cursor = response.nextCursor;
  }
  throw new CodexRuntimeError("unsafe-runtime", "Codex MCP inventory is incomplete.");
}

async function writeModelCatalog(input: CodexGenerationInput, directory: string): Promise<string> {
  const catalog: unknown = JSON.parse(await runCommand(input.command, ["debug", "models", "--bundled"], input.signal));
  if (!isRecord(catalog) || !Array.isArray(catalog.models) || input.model !== "gpt-6.1-sol")
    throw new CodexRuntimeError("unsupported-runtime", "The selected model has no verified Codex isolation profile.");
  const model = catalog.models.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.slug === input.model);
  if (!model) throw new CodexRuntimeError("unsupported-runtime", "The selected model is absent from this CLI catalog.");
  if (input.effort && (!Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.some((level) => isRecord(level) && level.effort === input.effort)))
    throw new CodexRuntimeError("unsupported-runtime", "The selected reasoning effort is unsupported.");
  const path = join(directory, "model-catalog.json");
  // Public metadata exported by this exact CLI, never its auth or account cache.
  // CLI 0.164.0 otherwise registers apply_patch even with the shell tool disabled.
  writeFileSync(path, JSON.stringify({ models: [{ ...model, apply_patch_tool_type: null }] }), { mode: 0o600, flag: "wx" });
  return path;
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function runCommand(command: readonly string[], args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new CodexRuntimeError("cancelled", "Codex analysis was cancelled.");
  let child;
  try {
    child = Bun.spawn([...command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
    });
  } catch {
    throw new CodexRuntimeError("cli-unavailable", "Codex CLI could not be started. Check its installation and selected executable.");
  }
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of child.stdout) {
      bytes += chunk.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error("CLI output limit");
      chunks.push(chunk);
    }
    if ((await child.exited) !== 0) throw new Error("CLI command failed");
    if (signal?.aborted) throw new CodexRuntimeError("cancelled", "Codex analysis was cancelled.");
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    if (signal?.aborted) throw new CodexRuntimeError("cancelled", "Codex analysis was cancelled.");
    throw new CodexRuntimeError("cli-unavailable", "Codex CLI command failed or exceeded its limits.");
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
}

export async function runCodexGeneration(input: CodexGenerationInput): Promise<CodexGenerationResult> {
  if (input.signal?.aborted) throw new CodexRuntimeError("cancelled", "Codex analysis was cancelled.");
  const version = await runCommand(input.command, ["--version"], input.signal);
  if (version.trim() !== "codex-cli 0.164.0") {
    throw new CodexRuntimeError("unsupported-runtime", "Codex CLI 0.164.0 is required for the verified isolation profile.");
  }
  const directory = mkdtempSync(join(tmpdir(), "raceiq-codex-"));
  let connection: CodexRpcConnection | undefined;
  const abortConnection = () => {
    void connection?.close().catch(() => {});
  };
  input.signal?.addEventListener("abort", abortConnection, { once: true });
  try {
    if (input.signal?.aborted) throw new CodexRuntimeError("cancelled", "Codex analysis was cancelled.");
    connection = connect(input.command, directory);
    await initialize(connection);
    await requireChatGptAccount(connection);
    await requireSafeFeatures(connection);
    const servers = await inventory(connection);
    await connection.close();
    const catalog = await writeModelCatalog(input, directory);
    let onNotification: (method: string, params: unknown) => void = () => {};
    connection = connect(
      input.command,
      directory,
      [...BASE_OVERRIDES, `model_catalog_json=${JSON.stringify(catalog)}`, ...servers.map((name) => `mcp_servers.${name}.enabled=false`)],
      (method, params) => onNotification(method, params),
    );
    await initialize(connection);
    await requireChatGptAccount(connection);
    await requireSafeFeatures(connection);
    const started = await connection.request("thread/start", {
      model: input.model,
      modelProvider: "openai",
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: "You are RaceIQ's read-only racing telemetry analyst, not a coding assistant. Analyze only supplied telemetry. No tools or external actions are authorized.",
      developerInstructions: "Return the requested analysis using supplied evidence only. Do not inspect files, execute commands, or use network, browser, computer, patch, MCP, app or agent tools.",
      dynamicTools: [],
    });
    if (!isRecord(started) || !isRecord(started.thread) || typeof started.thread.id !== "string" || started.model !== input.model || started.modelProvider !== "openai")
      throw new CodexRuntimeError("unsafe-runtime", "Codex did not create the requested isolated thread.");
    const threadId = started.thread.id;
    const scopedServers = await inventory(connection, threadId);
    if (scopedServers.some((name) => !servers.includes(name))) throw new CodexRuntimeError("unsafe-runtime", "Codex MCP configuration changed during isolation.");
    const start = performance.now();
    let firstContentMs: number | null = null;
    let text = "";
    let nativeUsage: Record<string, unknown> = {};
    let turnId: string | undefined;
    let completed!: (status: string) => void;
    const completion = new Promise<string>((resolve) => {
      completed = resolve;
    });
    onNotification = (method, params) => {
      if (!isRecord(params) || params.threadId !== threadId) return;
      if (typeof params.turnId === "string") {
        if (turnId && params.turnId !== turnId) return;
        turnId = params.turnId;
      }
      if (method === "thread/tokenUsage/updated" && isRecord(params.tokenUsage) && isRecord(params.tokenUsage.last)) nativeUsage = params.tokenUsage.last;
      if (method === "item/agentMessage/delta" && typeof params.delta === "string" && firstContentMs === null) firstContentMs = Math.round(performance.now() - start);
      if (
        method === "item/completed" &&
        isRecord(params.item) &&
        params.item.type === "agentMessage" &&
        (params.item.phase == null || params.item.phase === "final_answer") &&
        typeof params.item.text === "string"
      )
        text = params.item.text;
      if (method === "turn/completed" && isRecord(params.turn) && typeof params.turn.id === "string" && typeof params.turn.status === "string" && (!turnId || turnId === params.turn.id)) {
        turnId = params.turn.id;
        completed(params.turn.status);
      }
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new CodexRuntimeError("cancelled", "Codex analysis was cancelled."));
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      timeout = setTimeout(() => reject(new CodexRuntimeError("generation-failed", "Codex analysis exceeded its time limit.")), input.timeoutMs ?? 300_000);
    });
    try {
      const generation = (async () => {
        const response = await connection.request(
          "turn/start",
          { threadId, ...(input.schema ? { outputSchema: input.schema } : {}), ...(input.effort ? { effort: input.effort } : {}), input: [{ type: "text", text: input.prompt, text_elements: [] }] },
          { signal: input.signal },
        );
        if (!isRecord(response) || !isRecord(response.turn) || typeof response.turn.id !== "string" || (turnId && response.turn.id !== turnId))
          throw new CodexRuntimeError("generation-failed", "Codex turn acknowledgement is invalid.");
        turnId = response.turn.id;
        return completion;
      })();
      const status = await Promise.race([
        generation,
        stopped,
        connection.closed.then((error) => {
          throw error;
        }),
      ]);
      if (status !== "completed" || !text.trim()) throw new CodexRuntimeError("generation-failed", "Codex did not return a completed analysis.");
      if (input.schema) JSON.parse(text);
      return {
        text,
        status: "completed",
        runtimeVersion: "0.164.0",
        model: input.model,
        latencyMs: Math.round(performance.now() - start),
        firstContentMs,
        budget: { requestedOutputTokens: input.requestedOutputTokens ?? null, effectiveOutputTokens: null, supported: false },
        usage: {
          inputTokens: counter(nativeUsage.inputTokens),
          cachedInputTokens: counter(nativeUsage.cachedInputTokens),
          outputTokens: counter(nativeUsage.outputTokens),
          reasoningOutputTokens: counter(nativeUsage.reasoningOutputTokens),
          costUsd: null,
        },
      };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  } catch (error) {
    if (input.signal?.aborted) throw new CodexRuntimeError("cancelled", "Codex analysis was cancelled.");
    if (error instanceof CodexRuntimeError) throw error;
    throw new CodexRuntimeError("generation-failed", "Codex analysis failed. Check the CLI connection and sign-in status.");
  } finally {
    input.signal?.removeEventListener("abort", abortConnection);
    await connection?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
