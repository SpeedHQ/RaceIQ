import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCodexChatResponse } from "../server/ai/codex-chat-stream";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFakeExecutable(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-codex-stream-"));
  tempDirs.push(dir);
  const executable = join(dir, "codex-fake");
  writeFileSync(executable, `#!/bin/sh\nset -eu\n${script}\n`);
  chmodSync(executable, 0o755);
  return executable;
}

const completeOutput = (text: string) => [
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 6 } }),
].join("\n");

async function streamChunks(response: Response): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const body = await response.text();
  return [...body.matchAll(/^data: (.+)$/gm)]
    .map((match) => match[1])
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as { type: string; [key: string]: unknown });
}

describe("Codex chat UI stream", () => {
  test("emits shared start, text, and finish chunks after provider success", async () => {
    const priorExecutable = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = makeFakeExecutable(`printf '%s\\n' '${completeOutput("chat answer")}'`);
    try {
      const response = await createCodexChatResponse({
        systemPrompt: "system",
        messages: [{ role: "user", content: "question" }],
        model: "gpt-5",
      });
      const chunks = await streamChunks(response);
      expect(chunks.map((chunk) => chunk.type)).toEqual([
        "start", "text-start", "text-delta", "text-end", "finish",
      ]);
      expect(chunks.find((chunk) => chunk.type === "text-delta")).toMatchObject({ delta: "chat answer" });
      expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
    } finally {
      if (priorExecutable === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = priorExecutable;
    }
  });

  test("rejects provider failure before constructing a response stream", async () => {
    const priorExecutable = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = makeFakeExecutable("printf 'provider failed' >&2; exit 7");
    try {
      await expect(createCodexChatResponse({
        systemPrompt: "system",
        messages: [{ role: "user", content: "question" }],
      })).rejects.toThrow("Codex CLI failed");
    } finally {
      if (priorExecutable === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = priorExecutable;
    }
  });
});
