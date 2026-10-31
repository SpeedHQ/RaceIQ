// Trusted external CLI peer for integration tests. No authentication or inference.
import { readFileSync } from "node:fs";
const scenario = process.argv[2];
const args = process.argv.slice(3);
if (args.includes("--version")) {
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
        result = { turn: { id: "fixture-turn", status: "inProgress" } };
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
              item: { type: "agentMessage", id: "final", phase: scenario === "partial-only" ? "partial_answer" : "final_answer", text: '{"answer":"fixture analysis"}' },
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
