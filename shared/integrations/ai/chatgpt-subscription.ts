export const CHATGPT_SUBSCRIPTION_PROVIDER = "chatgpt-subscription";

export const CHATGPT_SUBSCRIPTION_ERROR_STATUS = {
  invalid_request: 400,
  forbidden: 403,
  attempt_in_progress: 409,
  reauth_required: 409,
  plan_unavailable: 409,
  model_unavailable: 409,
  usage_limit: 429,
  unavailable: 503,
  upstream_unavailable: 503,
  storage_failed: 500,
} as const;

export type ChatGptSubscriptionErrorCode = keyof typeof CHATGPT_SUBSCRIPTION_ERROR_STATUS;
export const CHATGPT_RECOVERY_MESSAGE = {
  reauth_required: "Reconnect ChatGPT in Settings.",
  usage_limit: "ChatGPT plan usage limit reached. Open ChatGPT usage settings.",
  plan_unavailable: "ChatGPT plan usage is unavailable for this account.",
  incomplete: "ChatGPT did not complete the request. Try again.",
} as const;

export type ChatGptRecoveryCode = keyof typeof CHATGPT_RECOVERY_MESSAGE;

export function chatGptRecoveryCode(error: unknown): ChatGptRecoveryCode | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  if (code === "reauth_required" || message === CHATGPT_RECOVERY_MESSAGE.reauth_required) return "reauth_required";
  if (code === "usage_limit" || code === "subscription_sharing_usage_limit_exceeded" || message === CHATGPT_RECOVERY_MESSAGE.usage_limit || message === "ChatGPT plan usage limit reached. Check ChatGPT Settings → Usage.") return "usage_limit";
  if (code === "plan_unavailable" || code === "subscription_sharing_usage_unavailable" || message === CHATGPT_RECOVERY_MESSAGE.plan_unavailable) return "plan_unavailable";
  if (code === "upstream_unavailable" || code === "unavailable" || code === "storage_failed" || message === CHATGPT_RECOVERY_MESSAGE.incomplete) return "incomplete";
  return null;
}

export function chatGptRecoveryMessage(error: unknown): string | null {
  const code = chatGptRecoveryCode(error);
  return code ? CHATGPT_RECOVERY_MESSAGE[code] : null;
}
export type ChatGptAttemptError = ChatGptSubscriptionErrorCode | "consent_denied" | "oauth_invalid" | "oauth_timeout";

export interface ChatGptSubscriptionState {
  availability: "available" | "unavailable";
  activeAccountId: string | null;
  accounts: {
    id: string;
    label: string;
    session: "connected" | "signed_out" | "reauth_required";
  }[];
  attempt: null | {
    id: string;
    accountId: string | null;
    status: "pending" | "succeeded" | "cancelled" | "failed";
    error: ChatGptAttemptError | null;
  };
}

export interface ChatGptConnectResult {
  attemptId: string;
  authorizationUrl: string;
}

export interface ChatGptSignOutResult {
  state: ChatGptSubscriptionState;
  revocation: "confirmed" | "unconfirmed" | "not_needed";
}

export interface ChatGptRequestUsage {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ChatGptTokenRates {
  input: number;
  cachedInput: number;
  output: number;
}

export interface ChatGptPricingSnapshot {
  fetchedAt: number | null;
  models: Record<string, ChatGptTokenRates & { longContext?: ChatGptTokenRates & { threshold: number } }>;
}

export function estimateChatGptApiCost(
  usage: readonly ChatGptRequestUsage[],
  pricing: ChatGptPricingSnapshot,
): number | null {
  if (!usage.length) return null;
  let cost = 0;
  for (const { model, inputTokens, cachedInputTokens, outputTokens } of usage) {
    const rate = Object.hasOwn(pricing.models, model) ? pricing.models[model] : undefined;
    if (!rate) return null;
    const effective = rate.longContext && inputTokens > rate.longContext.threshold ? rate.longContext : rate;
    cost += (inputTokens - cachedInputTokens) * effective.input + cachedInputTokens * effective.cachedInput + outputTokens * effective.output;
  }
  return cost / 1_000_000;
}
