// Trusted external CLI peer for integration tests. No authentication or inference.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const scenario = process.argv[2];
const args = process.argv.slice(3);
if (args.includes("--version")) {
  if (scenario === "stall-version") {
    writeFileSync(args[0], String(process.pid));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  console.log(scenario === "unsupported" ? "codex-cli 0.999.0" : "codex-cli 0.164.0");
  process.exit(0);
}
if (args.includes("--bundled")) {
  console.log(JSON.stringify({ models: [{ slug: "gpt-6.1-sol", apply_patch_tool_type: "freeform", supported_reasoning_levels: [{ effort: "low" }] }] }));
  process.exit(0);
}
if (!args.includes("app-server")) throw new Error("Unexpected test CLI command");
const excluded = [
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
let threadStarted = false;
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let boundary: number;
  while ((boundary = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 1);
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result: unknown;
    switch (message.method) {
      case "initialize":
        result = { userAgent: "fixture" };
        break;
      case "account/read":
        if (scenario === "stall-account") continue;
        result = { account: { type: scenario === "api-key" ? "apiKey" : "chatgpt" } };
        break;
      case "model/list":
        result = { data: [{ id: scenario === "unverified-model" ? "unverified" : "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }], nextCursor: null };
        break;
      case "experimentalFeature/list":
        result = {
          data: scenario === "missing-features" ? [] : excluded.filter((name) => name !== "shell_snapshot").map((name) => ({ name, enabled: scenario === "unsafe-feature" && name === "shell_tool" })),
          nextCursor: null,
        };
        break;
      case "mcpServerStatus/list":
        result = {
          data: [
            { name: "fixture-tools", tools: scenario !== "leaked-mcp" && args.includes("mcp_servers.fixture-tools.enabled=false") ? {} : { dangerous: {} } },
            ...(scenario === "new-server" && message.params.threadId ? [{ name: "new-unisolated-server", tools: {} }] : []),
          ],
          nextCursor: null,
        };
        break;
      case "thread/start": {
        const catalogArg = args.find((value) => value.startsWith("model_catalog_json="));
        if (!catalogArg || !args.includes("mcp_servers.fixture-tools.enabled=false") || !excluded.every((name) => args.includes(`features.${name}=false`))) throw new Error("Unsafe process profile");
        const catalog = JSON.parse(readFileSync(JSON.parse(catalogArg.slice("model_catalog_json=".length)), "utf8"));
        if (
          catalog.models[0]?.apply_patch_tool_type !== null ||
          message.params.sandbox !== "read-only" ||
          message.params.approvalPolicy !== "never" ||
          message.params.ephemeral !== true ||
          message.params.dynamicTools.length !== 0
        )
          throw new Error("Unsafe thread profile");
        threadStarted = true;
        result = { thread: { id: "fixture-thread" }, model: "gpt-6.1-sol", modelProvider: "openai" };
        break;
      }
      case "turn/start": {
        if (!threadStarted || "maxOutputTokens" in message.params || "max_output_tokens" in message.params) throw new Error("Unsafe generation input");
        if (scenario === "provider" && (!message.params.input[0]?.text.includes("SYSTEM_CONTEXT") || !message.params.input[0]?.text.includes("LAP_CONTEXT") || message.params.outputSchema?.properties?.answer?.type !== "string")) throw new Error("Provider lost supplied context or schema");
        if (scenario === "comparison" && (!message.params.input[0]?.text.includes("COMPARATIVE lap analysis") || !message.params.input[0]?.text.includes("Focus on throttle pickup.") || !message.params.outputSchema?.properties?.segments)) throw new Error("Comparison lost persona, preferences or schema");
        result = { turn: { id: "fixture-turn", status: "inProgress" } };
        if (scenario === "stubborn-turn") {
          writeFileSync(args[0], String(process.pid));
          // Resist stdin EOF like an in-flight external runtime; the owner must
          // terminate and reap us. The test-only stop file prevents leaked peers on RED.
          setInterval(() => { if (existsSync(`${args[0]}.stop`)) process.exit(0); }, 10);
          process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
          continue;
        }
        if (scenario === "exit-after-ack") {
          process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n", () => process.exit(0));
          continue;
        }
        const events = [
          { method: "item/agentMessage/delta", params: { threadId: "fixture-thread", turnId: "fixture-turn", itemId: "final", delta: '{"answer":' } },
          {
            method: "item/completed",
            params: {
              threadId: "fixture-thread",
              turnId: "fixture-turn",
              item: { type: "agentMessage", id: "final", phase: scenario === "partial-only" ? "partial_answer" : "final_answer", text: scenario === "comparison" ? JSON.stringify({ verdict: "Lap A is faster", segments: [{ name: "T1", deltaSeconds: -0.2, throttle: "A reaches full throttle 10m earlier", brake: "Similar", steering: "Similar", action: "Reach 100% throttle 10m earlier", severity: "moderate" }], coaching: [{ tip: "Earlier throttle", detail: "At T1", targetLap: "B" }] }) : '{"answer":"fixture analysis"}' },
            },
          },
          {
            method: "thread/tokenUsage/updated",
            params: { threadId: "fixture-thread", turnId: "fixture-turn", tokenUsage: { last: { inputTokens: 123, cachedInputTokens: 0, outputTokens: 42, reasoningOutputTokens: 2 } } },
          },
          { method: "turn/completed", params: { threadId: "fixture-thread", turn: { id: "fixture-turn", status: scenario === "failed" ? "failed" : "completed", error: null } } },
        ];
        for (const event of events) {
          if (scenario === "missing-usage" && event.method === "thread/tokenUsage/updated") continue;
          process.stdout.write(JSON.stringify(event) + "\n");
          if (scenario === "foreign-usage" && event.method === "thread/tokenUsage/updated")
            process.stdout.write(
              JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "fixture-thread", turnId: "other-turn", tokenUsage: { last: { inputTokens: 999, outputTokens: 987 } } } }) +
                "\n",
            );
        }
        break;
      }
      default:
        throw new Error("Unexpected RPC method");
    }
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
  }
}
if (scenario === "completed-awaiting-close" && threadStarted) {
  writeFileSync(args[0], String(process.pid));
  setInterval(() => { if (existsSync(`${args[0]}.stop`)) process.exit(0); }, 10);
  await new Promise(() => {});
}
