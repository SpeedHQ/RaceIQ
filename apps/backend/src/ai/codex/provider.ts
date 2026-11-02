import type { AiFeature, AiResult, ResolvedAi, StructuredRequest, TextRequest } from "@raceiq/backend-core/ai/ai-types";
import { AiProviderError } from "@raceiq/backend-core/ai/provider-error";
import { CodexRuntimeError } from "./runtime";
import { codexSupervisor } from "./supervisor";

/** Only the isolated Codex runtime can execute this trusted, backend-owned prefix. */
export class CodexProviderAdapter implements ResolvedAi {
  readonly provider = "codex";
  readonly feature: AiFeature;
  readonly model: string;
  readonly #command: readonly string[];

  constructor(config: { feature: AiFeature; model: string; command: readonly string[] }) {
    this.feature = config.feature;
    this.model = config.model;
    this.#command = [...config.command];
  }

  generateText(input: TextRequest): Promise<AiResult> {
    return this.#generate(input);
  }

  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult> {
    if (!input.schema || typeof input.schema !== "object" || Array.isArray(input.schema)) {
      throw new AiProviderError("Codex structured generation requires a JSON Schema object.", { code: "unsupported-operation", provider: this.provider, modelId: this.model });
    }
    return this.#generate(input, input.schema);
  }

  async #generate(input: TextRequest, schema?: object): Promise<AiResult> {
    const startedAt = performance.now();
    try {
      const { text, ...diagnostics } = await codexSupervisor.run({
        command: this.#command,
        model: this.model,
        ...(this.model === "gpt-6-luna" ? { effort: "medium" as const } : {}),
        prompt: input.system ? `${input.system}\n\n${input.prompt}` : input.prompt,
        schema,
        signal: input.signal,
        requestedOutputTokens: input.maxOutputTokens,
      });
      return {
        analysis: text,
        usage: { inputTokens: diagnostics.usage.inputTokens, outputTokens: diagnostics.usage.outputTokens, costUsd: null, durationMs: performance.now() - startedAt, model: diagnostics.model },
        diagnostics: { provider: this.provider, ...diagnostics },
      };
    } catch (error) {
      const code = error instanceof CodexRuntimeError ? error.code : "upstream";
      const statusCode = code === "cancelled" ? 499 : code === "not-signed-in" ? 401 : code === "usage-limit" || code === "rate-limit" ? 429 : code === "upstream" || code === "generation-failed" ? 502 : 503;
      throw new AiProviderError(error instanceof CodexRuntimeError ? error.message : "Codex generation failed. Check the configured CLI installation.", {
        code,
        statusCode,
        provider: this.provider,
        modelId: this.model,
        isRetryable: code === "usage-limit" || code === "rate-limit",
      });
    }
  }
}
