type UpstreamError = {
  code?: number;
  message?: string;
  status?: string;
};

export type ClientAiError = {
  message: string;
  statusCode: number | null;
  retryable: boolean;
  provider: string | null;
  modelId: string | null;
  upstream: UpstreamError | null;
};

function parseUpstreamError(responseBody: unknown): UpstreamError | null {
  if (typeof responseBody !== "string" || responseBody.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(responseBody) as { error?: UpstreamError };
    if (!parsed || typeof parsed !== "object" || !parsed.error || typeof parsed.error !== "object") return null;
    return {
      code: typeof parsed.error.code === "number" ? parsed.error.code : undefined,
      message: typeof parsed.error.message === "string" ? parsed.error.message : undefined,
      status: typeof parsed.error.status === "string" ? parsed.error.status : undefined,
    };
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

  return {
    message,
    statusCode: typeof e.statusCode === "number" ? e.statusCode : null,
    retryable: Boolean(e.isRetryable),
    provider: typeof e.provider === "string" ? e.provider : null,
    modelId: typeof e.modelId === "string" ? e.modelId : null,
    upstream: upstream
      ? {
        code: typeof upstream.code === "number" ? upstream.code : undefined,
        message: typeof upstream.message === "string" ? upstream.message : undefined,
        status: typeof upstream.status === "string" ? upstream.status : undefined,
      }
      : null,
  };
}
