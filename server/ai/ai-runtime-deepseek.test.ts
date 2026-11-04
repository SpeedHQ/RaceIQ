import { describe, expect, test } from "bun:test";

import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";

import { resolveAi } from "../../apps/backend/src/ai/ai-runtime";

/**
 * 回归测试：DeepSeek 必须能通过 resolveAi 的 provider 白名单。
 *
 * 修复前 `ai-runtime.ts` 的白名单只认 gemini/openai/anthropic/openai-compatible，
 * 选 DeepSeek 会抛 "Unsupported AI provider"；修复后它会进入 deepseek 分支，
 * 因为本机没有存 key，最终报 "DeepSeek API key not set"。
 *
 * 断言的是具体错误文案，因此这条测试在两种失败下都会失败：
 * 白名单回退（unsupported）或分支缺失（走错适配器）。
 */
describe("resolveAi — DeepSeek 进入运行时分支", () => {
  test("缺 key 时报缺 key，而不是 unsupported provider", async () => {
    const settings = {
      ...loadSettings(),
      aiProvider: "deepseek" as const,
      aiModel: "deepseek-flash",
    };

    await expect(resolveAi("analysis", settings)).rejects.toThrow(/DeepSeek API key/);
  });
});
