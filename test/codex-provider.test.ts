import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCodexStatus,
  parseCodexJsonl,
  runCodexCli,
  type CodexCliOptions,
} from "../server/ai/provider-adapters";
import { loadSettings } from "../server/settings";
import { resolveAi } from "../server/ai/ai-runtime";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFakeExecutable(script: string): { executable: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "raceiq-codex-"));
  tempDirs.push(dir);
  const executable = join(dir, "codex-fake");
  writeFileSync(executable, `#!/bin/sh\nset -eu\n${script}\n`);
  chmodSync(executable, 0o755);
  return { executable, dir };
}

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("parseCodexJsonl", () => {
  test("extracts final agent message and usage while ignoring progress events", () => {
    const raw = jsonl(
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.started", item: { type: "reasoning", summary: [] } },
      { type: "item.completed", item: { type: "reasoning", summary: ["thinking"] } },
      { type: "item.completed", item: { type: "agent_message", text: "final answer" } },
      { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 7 } },
    );

    expect(parseCodexJsonl(raw)).toEqual({
      text: "final answer",
      model: "codex",
      inputTokens: 12,
      outputTokens: 7,
    });
  });

  test("uses last agent message when a turn emits multiple messages", () => {
    expect(parseCodexJsonl(jsonl(
      { type: "item.completed", item: { type: "agent_message", text: "intermediate" } },
      { type: "item.completed", item: { type: "agent_message", text: "final" } },
      { type: "turn.completed", usage: {} },
    )).text).toBe("final");
  });

  test("rejects malformed non-empty JSONL", () => {
    expect(() => parseCodexJsonl(`${jsonl({ type: "turn.started" })}\nnot-json`)).toThrow("malformed");
  });

  test("rejects output missing turn completion", () => {
    expect(() => parseCodexJsonl(jsonl(
      { type: "item.completed", item: { type: "agent_message", text: "answer" } },
    ))).toThrow("completed");
  });

  test("rejects output without an agent message", () => {
    expect(() => parseCodexJsonl(jsonl({ type: "thread.started" }, { type: "turn.completed" }))).toThrow("empty response");
  });

  test("rejects empty output", () => {
    expect(() => parseCodexJsonl(" \n\t")).toThrow("empty response");
  });
});

describe("Codex subprocess", () => {
  test("passes exec arguments and stdin without exposing OPENAI_API_KEY", async () => {
    const argsFile = join(tmpdir(), `raceiq-codex-args-${crypto.randomUUID()}`);
    const stdinFile = join(tmpdir(), `raceiq-codex-stdin-${crypto.randomUUID()}`);
    const keyFile = join(tmpdir(), `raceiq-codex-key-${crypto.randomUUID()}`);
    const { executable } = makeFakeExecutable(`
printf '%s\\n' "$@" > "$CODEX_ARGS_FILE"
cat > "$CODEX_STDIN_FILE"
printf '%s' "\${OPENAI_API_KEY-<missing>}" > "$CODEX_KEY_FILE"
printf '%s\\n' '${jsonl(
  { type: "item.completed", item: { type: "agent_message", text: "ok" } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
)}'
`);
    const priorKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-reach-codex";
    try {
      const options: CodexCliOptions = {
        executable,
        env: { CODEX_ARGS_FILE: argsFile, CODEX_STDIN_FILE: stdinFile, CODEX_KEY_FILE: keyFile },
      };
      await expect(runCodexCli("stdin prompt", "gpt-5", options)).resolves.toMatchObject({
        analysis: "ok",
        usage: { inputTokens: 1, outputTokens: 2, model: "gpt-5" },
      });
      expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
        "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--model", "gpt-5", "-",
      ]);
      expect(readFileSync(stdinFile, "utf8")).toBe("stdin prompt");
      expect(readFileSync(keyFile, "utf8")).toBe("<missing>");
    } finally {
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
      rmSync(argsFile, { force: true });
      rmSync(stdinFile, { force: true });
      rmSync(keyFile, { force: true });
    }
  });
  test("uses Codex CLI configured default for codex-default model", async () => {
    const argsFile = join(tmpdir(), `raceiq-codex-default-args-${crypto.randomUUID()}`);
    const { executable } = makeFakeExecutable(`
printf '%s\\n' "$@" > "$CODEX_ARGS_FILE"
printf '%s\\n' '${jsonl(
  { type: "item.completed", item: { type: "agent_message", text: "ok" } },
  { type: "turn.completed", usage: {} },
)}'
`);
    try {
      await expect(runCodexCli("prompt", "codex-default", {
        executable,
        env: { CODEX_ARGS_FILE: argsFile },
      })).resolves.toMatchObject({ usage: { model: "codex-default" } });
      expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
        "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-",
      ]);
    } finally {
      rmSync(argsFile, { force: true });
    }
  });

  test("reports non-zero exit with truncated stderr", async () => {
    const { executable } = makeFakeExecutable(`
printf 'e%.0s' $(seq 1 400) >&2
exit 9
`);
    const error = await runCodexCli("prompt", undefined, { executable }).then(
      () => new Error("expected rejection"),
      (cause) => cause as Error,
    );
    expect(error.message).toContain("Codex CLI failed");
    expect(error.message).toContain("e".repeat(240));
    expect(error.message).not.toContain("e".repeat(241));
  });

  test("kills timed-out subprocess", async () => {
    const { executable } = makeFakeExecutable("sleep 1");
    await expect(runCodexCli("prompt", undefined, { executable, timeoutMs: 20 })).rejects.toThrow("timed out");
  });
  test("terminates timed-out child process tree before returning", async () => {
    const pidFile = join(tmpdir(), `raceiq-codex-child-pid-${crypto.randomUUID()}`);
    const marker = join(tmpdir(), `raceiq-codex-child-${crypto.randomUUID()}`);
    const { executable } = makeFakeExecutable(`
(sleep 1000; printf orphaned > "$CODEX_CHILD_MARKER") &
child=$!
printf '%s' "$child" > "$CODEX_CHILD_PID_FILE"
wait
`);
    const ready = new Promise<void>((resolve) => {
      const watcher = watch(tmpdir(), (_event, filename) => {
        if (String(filename) === pidFile.slice(pidFile.lastIndexOf("/") + 1)) {
          watcher.close();
          resolve();
        }
      });
    });
    const run = runCodexCli("prompt", undefined, {
      executable,
      timeoutMs: 500,
      env: { CODEX_CHILD_MARKER: marker, CODEX_CHILD_PID_FILE: pidFile },
    });
    try {
      await ready;
      const childPid = Number(readFileSync(pidFile, "utf8"));
      await expect(run).rejects.toThrow("timed out");
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(() => readFileSync(marker, "utf8")).toThrow();
    } finally {
      rmSync(pidFile, { force: true });
      rmSync(marker, { force: true });
    }
  });
});


describe("Codex readiness", () => {
  test("reports missing executable", async () => {
    await expect(getCodexStatus({ executable: join(tmpdir(), `missing-codex-${crypto.randomUUID()}`) })).resolves.toMatchObject({
      ready: false,
      reason: expect.stringContaining("not found"),
    });
  });

  test("reports unauthenticated login status", async () => {
    const { executable } = makeFakeExecutable(`
printf 'Not logged in\\n' >&2
exit 1
`);
    await expect(getCodexStatus({ executable })).resolves.toMatchObject({
      ready: false,
      reason: expect.stringContaining("Not logged in"),
    });
  });

  test("reports ready login status", async () => {
    const { executable } = makeFakeExecutable("exit 0");
    await expect(getCodexStatus({ executable })).resolves.toEqual({ ready: true });
  });
});

test("settings-aware runtime selects Codex without API-key lookup", async () => {
  const settings = { ...loadSettings(), aiProvider: "codex" as const, aiModel: "gpt-5" };
  await expect(resolveAi("analysis", settings)).resolves.toMatchObject({
    provider: "codex",
    model: "gpt-5",
  });
});
