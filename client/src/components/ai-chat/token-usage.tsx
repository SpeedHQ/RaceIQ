"use client";

import { useAuiState } from "@assistant-ui/react";
import { useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import { contextWindowFor } from "@raceiq/shared/integrations/ai/context-window"
import { estimateChatGptApiCost, type ChatGptRequestUsage } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import { useQuery } from "@tanstack/react-query";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/settings";
import { authenticatedFetch, client } from "@/lib/rpc";
import type { ChatGeneration } from "./chat-history";
import { formatTokens, meterLevel } from "./token-usage-format";

const RATE_PER_MTOK: Record<string, { in: number; out: number }> = {
  gemini: { in: 0.1, out: 0.4 },
  openai: { in: 0.15, out: 0.6 },
  "openai-compatible": { in: 0, out: 0 },
};

export function TokenUsageFooter({
  compactThreadId,
  generations,
  viewingGen,
  activeGen,
  onViewGen,
}: {
  compactThreadId?: string;
  generations: ChatGeneration[];
  viewingGen: number;
  activeGen: number;
  onViewGen: (gen: number) => void;
}) {
  const usage = useThreadTokenUsage();
  const { displaySettings } = useSettings();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const subscriptionUsage = useAuiState((s) => {
    const lastAssistant = s.thread.messages.findLast((message) => message.role === "assistant");
    return lastAssistant?.metadata.custom.subscriptionUsage as ChatGptRequestUsage[] | undefined;
  });
  const { data: pricing } = useQuery({
    queryKey: ["ai-chat-pricing"],
    queryFn: async () => {
      const res = await client.api["ai-chat-pricing"].$get();
      if (!res.ok) throw new Error(`AI chat pricing failed (${res.status})`);
      return res.json();
    },
    enabled: Boolean(subscriptionUsage?.length),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const subscriptionCost = subscriptionUsage && pricing ? estimateChatGptApiCost(subscriptionUsage, pricing) : null;
  const provider = displaySettings.chatProvider ?? "";
  const model = displaySettings.chatModel ?? "";
  const { data: openAiCompatibleModels } = useQuery({
    queryKey: ["ai-models", "openai-compatible-context"],
    queryFn: async () => {
      const res = await fetch("/api/ai-models?providers=openai-compatible");
      if (!res.ok) throw new Error(`ai-models failed (${res.status})`);
      const body = (await res.json()) as { "openai-compatible"?: { id: string; contextLength?: number }[] };
      return body["openai-compatible"] ?? [];
    },
    enabled: provider === "openai-compatible",
    staleTime: 60_000,
  });
  const openAiCompatibleContext =
    provider === "openai-compatible"
      ? (openAiCompatibleModels?.find((m) => m.id === model) ?? (openAiCompatibleModels?.length === 1 ? openAiCompatibleModels[0] : undefined))?.contextLength
      : undefined;
  const limit = contextWindowFor(provider, model, openAiCompatibleContext);
  const estimatedTokens = useAuiState((s) => {
    let chars = s.composer.text.length;
    for (const m of s.thread.messages) {
      for (const part of m.content) {
        if (part.type === "text" || part.type === "reasoning") chars += part.text.length;
      }
    }
    return Math.ceil(chars / 4);
  });
  const used = usage?.inputTokens || estimatedTokens;
  const level = meterLevel(used, limit ?? 0);
  const barColor = level === "danger" ? "bg-status-danger" : level === "warn" ? "bg-status-warning" : "bg-app-border";
  const pct = limit != null && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const rate = RATE_PER_MTOK[provider] ?? { in: 0, out: 0 };
  const cost = ((usage?.inputTokens ?? 0) * rate.in + (usage?.outputTokens ?? 0) * rate.out) / 1_000_000;
  const activeThreadId = generations.find((g) => g.active)?.threadId ?? compactThreadId;

  const maxGen = generations.length ? generations[generations.length - 1].generation : activeGen;
  const hasUsage = (usage?.totalTokens ?? 0) > 0;
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-app-border/40 px-2 py-1 text-app-micro text-app-text-muted tabular-nums">
      {model && <span className="min-w-0 break-all">{m.ai_model_label()}: {model}</span>}
      <span className="flex items-center gap-1" title={level === "ok" ? undefined : m.ai_chat_context_filling()}>
        <span>
          {formatTokens(used)} / {limit != null ? formatTokens(limit) : "?"}
        </span>
        {limit != null && (
          <span className="inline-block h-1 w-10 rounded-full bg-app-border/30 overflow-hidden">
            <span className={`block h-full ${barColor}`} style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      {hasUsage && <span>{usage!.totalTokens} {m.ai_chat_tokens_short()}</span>}
      {hasUsage && usage!.inputTokens != null && <span>{m.ai_chat_input_short()} {usage!.inputTokens}</span>}
      {hasUsage && usage!.outputTokens != null && <span>{m.ai_chat_output_short()} {usage!.outputTokens}</span>}
      {hasUsage && (usage!.reasoningTokens ?? 0) > 0 && <span>{m.ai_chat_reasoning_short()} {usage!.reasoningTokens}</span>}
      {hasUsage && (usage!.cachedInputTokens ?? 0) > 0 && <span>{m.ai_chat_cached_short()} {usage!.cachedInputTokens}</span>}
      {!isRunning && subscriptionCost != null && subscriptionCost > 0 && pricing?.fetchedAt != null && (
        <span title={m.ai_chat_api_rates_fetched({ date: new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" }).format(pricing.fetchedAt) })}>
          {m.ai_chat_estimated_api_cost({ amount: new Intl.NumberFormat(getLocale(), {
            style: "currency", currency: "USD", maximumFractionDigits: 8,
          }).format(subscriptionCost) })}
        </span>
      )}
      {!subscriptionUsage && hasUsage && cost > 0 && <span>≈ ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}</span>}
      {maxGen > 1 && (
        <span className="flex items-center gap-0.5">
          <Button
            type="button"
            onClick={() => onViewGen(Math.max(1, viewingGen - 1))}
            disabled={viewingGen <= 1}
            className="px-1 rounded border border-app-border/50 hover:bg-app-surface-hover/20 disabled:opacity-30"
            title={m.ai_chat_previous_generation()}
          >
            ‹
          </Button>
          <span>
            gen {viewingGen}/{maxGen}
          </span>
          <Button
            type="button"
            onClick={() => onViewGen(Math.min(maxGen, viewingGen + 1))}
            disabled={viewingGen >= maxGen}
            className="px-1 rounded border border-app-border/50 hover:bg-app-surface-hover/20 disabled:opacity-30"
            title={m.ai_chat_next_generation()}
          >
            ›
          </Button>
        </span>
      )}
      {activeThreadId && isRunning && (
        <Button
          type="button"
          onClick={() => {
            void authenticatedFetch(`/api/chats/${encodeURIComponent(activeThreadId)}/run/cancel`, { method: "POST" });
          }}
          className="px-1.5 py-0.5 rounded border border-app-border/50 hover:bg-app-surface-hover/20"
          title={m.ai_chat_stop_server_turn()}
        >
          {m.common_cancel()}
        </Button>
      )}
    </div>
  );
}
