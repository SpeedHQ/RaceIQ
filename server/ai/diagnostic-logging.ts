import { log } from "../runtime/logger";

export type LlmDiagnosticContext = { provider: string; model: string; operation: string; threadId?: string };
export type LlmDiagnosticEvent = LlmDiagnosticContext & { request?: unknown; response?: unknown; error?: unknown };
const CREDENTIAL_KEY = /^(authorization|apiKey|api_key|token|secret)$/i;

export function normalizeDiagnostic(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    const errorRecord: Record<string, unknown> = { name: value.name, message: value.message, stack: value.stack };
    if ("responseBody" in value) errorRecord.responseBody = normalizeDiagnostic(value.responseBody, seen);
    return errorRecord;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => normalizeDiagnostic(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) output[key] = CREDENTIAL_KEY.test(key) ? "<REDACTED>" : normalizeDiagnostic(child, seen);
  return output;
}

export function logLlmEvent(kind: "llm-request" | "llm-response" | "llm-error", event: LlmDiagnosticEvent): void {
  const normalized = normalizeDiagnostic(event) as Record<string, unknown>;
  if (typeof normalized.request === "string") normalized.request = normalized.request.replace(/([?&]key=)[^&\s]+/gi, "$1<REDACTED>");
  log.info({ event: kind, ...normalized }, kind);
}

export async function withLlmDiagnostics<T>(context: LlmDiagnosticContext & { request: unknown }, run: () => Promise<T>): Promise<T> {
  logLlmEvent("llm-request", context);
  try {
    const response = await run();
    logLlmEvent("llm-response", { ...context, response });
    return response;
  } catch (error) {
    logLlmEvent("llm-error", { ...context, error });
    throw error;
  }
}
