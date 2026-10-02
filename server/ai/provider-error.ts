export type AiProviderErrorCode =
  | "missing-provider"
  | "missing-model"
  | "unsupported-provider"
  | "missing-api-key"
  | "upstream"
  | "unsupported-operation";

type UpstreamError = {
  code?: number;
  message?: string;
  status?: string;
  promptTokens?: number;
  contextLength?: number;
};

export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly statusCode: number | null;
  readonly isRetryable: boolean;
  readonly responseBody?: string;

  constructor(
    message: string,
    options: {
      code: AiProviderErrorCode;
      provider?: string | null;
      modelId?: string | null;
      statusCode?: number | null;
      isRetryable?: boolean;
      responseBody?: string;
    },
  ) {
    super(message);
    this.name = "AiProviderError";
    this.code = options.code;
    this.provider = options.provider ?? null;
    this.modelId = options.modelId ?? null;
    this.statusCode = options.statusCode ?? null;
    this.isRetryable = options.isRetryable ?? false;
    this.responseBody = options.responseBody;
  }
}

export type ClientAiError = {
  message: string;
  statusCode: number | null;
  retryable: boolean;
  provider: string | null;
  modelId: string | null;
  upstream: UpstreamError | null;
};

export function formatClientAiErrorMessage(error: ClientAiError): string {
  const upstreamMessage = error.upstream?.message?.trim();
  if (upstreamMessage && upstreamMessage !== error.message) {
    return `${error.message}: ${upstreamMessage}`;
  }
  return error.message;
}

function parseUpstreamError(responseBody: unknown): UpstreamError | null {
  if (typeof responseBody !== "string" || responseBody.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(responseBody) as { error?: UpstreamError; message?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.error && typeof parsed.error === "object") {
      return {
        code: typeof parsed.error.code === "number" ? parsed.error.code : undefined,
        message: typeof parsed.error.message === "string" ? parsed.error.message : undefined,
        status: typeof parsed.error.status === "string" ? parsed.error.status : undefined,
        promptTokens: typeof (parsed.error as any).n_prompt_tokens === "number" ? (parsed.error as any).n_prompt_tokens : undefined,
        contextLength: typeof (parsed.error as any).n_ctx === "number" ? (parsed.error as any).n_ctx : undefined,
      };
    }
    if (typeof parsed.message === "string") {
      const embedded = parsed.message.match(/\{[\s\S]*\}$/)?.[0];
      const nested = embedded ? parseUpstreamError(embedded) : null;
      return nested ?? { message: parsed.message };
    }
    return null;
  } catch {
    return null;
  }
}

export function toClientAiError(err: unknown): ClientAiError {
  const e = (err ?? {}) as {
    message?: unknown;
    statusCode?: unknown;
    isRetryable?: unknown;
    provider?: unknown;
    modelId?: unknown;
    responseBody?: unknown;
    data?: { error?: UpstreamError };
  };

  const parsedBody = parseUpstreamError(e.responseBody);
  const upstreamFromData = e.data?.error;
  const upstream = parsedBody ?? (upstreamFromData && typeof upstreamFromData === "object" ? upstreamFromData : null);
  const message = typeof e.message === "string"
    ? e.message
    : typeof upstream?.message === "string"
      ? upstream.message
      : String(err);
  const clientUpstream = upstream
    ? {
      code: typeof upstream.code === "number" ? upstream.code : undefined,
      message: typeof upstream.message === "string" ? upstream.message : undefined,
      status: typeof upstream.status === "string" ? upstream.status : undefined,
      ...(typeof upstream.promptTokens === "number" ? { promptTokens: upstream.promptTokens } : {}),
      ...(typeof upstream.contextLength === "number" ? { contextLength: upstream.contextLength } : {}),
    }
    : null;

  return {
    message,
    statusCode: typeof e.statusCode === "number" ? e.statusCode : null,
    retryable: Boolean(e.isRetryable),
    provider: typeof e.provider === "string" ? e.provider : null,
    modelId: typeof e.modelId === "string" ? e.modelId : null,
    upstream: clientUpstream,
  };
}
