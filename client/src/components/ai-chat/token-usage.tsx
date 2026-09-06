"use client";

import { useAuiState } from "@assistant-ui/react";
import { useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import { contextWindowFor } from "@shared/integrations/ai/context-window";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/settings";
import { client } from "@/lib/rpc";
import type { ChatGeneration } from "./chat-history";
import { formatTokens, meterLevel } from "./token-usage-format";

const RATE_PER_MTOK: Record<string, { in: number; out: number }> = {
  gemini: { in: 0.1, out: 0.4 },
  openai: { in: 0.15, out: 0.6 },
  "openai-compatible": { in: 0, out: 0 },
};

export function TokenUsageFooter({
  compactThreadId,
  historyQueryKey,
  compacting,
  setCompacting,
  generations,
  viewingGen,
  activeGen,
  onViewGen,
  onForked,
}: {
  compactThreadId?: string;
  historyQueryKey: unknown[];
  compacting: boolean;
  setCompacting: (v: boolean) => void;
  generations: ChatGeneration[];
  viewingGen: number;
  activeGen: number;
  onViewGen: (gen: number) => void;
  onForked: (newGen: number) => void;
}) {
  const usage = useThreadTokenUsage();
  const { displaySettings } = useSettings();
  const queryClient = useQueryClient();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [compactMsg, setCompactMsg] = useState<string | null>(null);
  const settings = displaySettings as { aiProvider?: string; aiModel?: string; chatProvider?: string; chatModel?: string };
  const provider = settings.chatProvider ?? settings.aiProvider ?? "";
  const model = settings.chatModel ?? settings.aiModel ?? "";
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
  const openAiCompatibleContext = provider === "openai-compatible" ? (openAiCompatibleModels?.find((m) => m.id === model) ?? (openAiCompatibleModels?.length === 1 ? openAiCompatibleModels[0] : undefined))?.contextLength : undefined;
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

  async function onNewChat() {
    if (!compactThreadId || compacting || isRunning) return;
    setCompacting(true);
    setCompactMsg(null);
    try {
      const res = await client.api.chats[":threadId"].compact.$post({ param: { threadId: compactThreadId } });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined;
        setCompactMsg(error ?? "Compact failed");
      } else {
        const body = (await res.json()) as { generation: number };
        await queryClient.invalidateQueries({ queryKey: ["chat-generations", compactThreadId] });
        await queryClient.invalidateQueries({ queryKey: historyQueryKey.slice(0, -1) });
        onForked(body.generation);
      }
    } catch {
      setCompactMsg("Compact failed");
    } finally {
      setCompacting(false);
      setTimeout(() => setCompactMsg(null), 4000);
    }
  }

  const maxGen = generations.length ? generations[generations.length - 1].generation : activeGen;
  const hasUsage = (usage?.totalTokens ?? 0) > 0;
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-app-border/40 px-2 py-1 text-app-micro text-app-text-muted tabular-nums">
      <span className="flex items-center gap-1" title={level === "ok" ? undefined : "Context is filling up — consider starting a new chat"}>
        <span>
          {formatTokens(used)} / {limit != null ? formatTokens(limit) : "?"}
        </span>
        {limit != null && (
          <span className="inline-block h-1 w-10 rounded-full bg-app-border/30 overflow-hidden">
            <span className={`block h-full ${barColor}`} style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      {hasUsage && <span>{usage!.totalTokens} tok</span>}
      {hasUsage && usage!.inputTokens != null && <span>in {usage!.inputTokens}</span>}
      {hasUsage && usage!.outputTokens != null && <span>out {usage!.outputTokens}</span>}
      {hasUsage && (usage!.reasoningTokens ?? 0) > 0 && <span>think {usage!.reasoningTokens}</span>}
      {hasUsage && (usage!.cachedInputTokens ?? 0) > 0 && <span>cached {usage!.cachedInputTokens}</span>}
      {hasUsage && cost > 0 && <span>≈ ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}</span>}
      {maxGen > 1 && (
        <span className="flex items-center gap-0.5">
          <Button
            type="button"
            onClick={() => onViewGen(Math.max(1, viewingGen - 1))}
            disabled={viewingGen <= 1}
            className="px-1 rounded border border-app-border/50 hover:bg-app-surface-hover/20 disabled:opacity-30"
            title="Previous chat generation"
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
            title="Next chat generation"
          >
            ›
          </Button>
        </span>
      )}
      {activeThreadId && isRunning && (
        <Button
          type="button"
          onClick={() => {
            void fetch(`/api/chats/${encodeURIComponent(activeThreadId)}/run/cancel`, { method: "POST" });
          }}
          className="px-1.5 py-0.5 rounded border border-app-border/50 hover:bg-app-surface-hover/20"
          title="Stop the agent turn on the server (not just this view)"
        >
          Cancel
        </Button>
      )}
      {compactThreadId && (
        <Button
          type="button"
          onClick={onNewChat}
          disabled={compacting || isRunning}
          className="ml-auto px-1.5 py-0.5 rounded border border-app-border/50 hover:bg-app-surface-hover/20 disabled:opacity-40"
          title="Compact this chat into a summary and continue in a fresh chat (keeps this chat as read-only history)"
        >
          {compacting ? "Compacting…" : "Compact & New chat"}
        </Button>
      )}
      {compactMsg && <span className="text-app-text-dim">{compactMsg}</span>}
    </div>
  );
}
