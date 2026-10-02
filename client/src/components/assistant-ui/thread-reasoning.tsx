"use client";

import { useAuiState } from "@assistant-ui/react";
import type { FC, PropsWithChildren } from "react";
import { ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger } from "@/components/assistant-ui/reasoning";
import type { ThreadGroupPart } from "./thread-context";

function useReasoningDurationSec(): number | undefined {
  return useAuiState((s) => {
    const ms = (s.message.metadata as { reasoning?: { durationMs?: number } } | undefined)?.reasoning?.durationMs;
    return typeof ms === "number" && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : undefined;
  });
}

export const ReasoningGroupFallback: FC<PropsWithChildren<{ group: ThreadGroupPart }>> = ({ group, children }) => {
  const startIndex = group.indices[0] ?? 0;
  const endIndex = group.indices[group.indices.length - 1] ?? -1;
  const isReasoningStreaming = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    const lastIndex = s.message.parts.length - 1;
    if (lastIndex < 0) return false;
    const lastType = s.message.parts[lastIndex]?.type;
    if (lastType !== "reasoning") return false;
    return lastIndex >= startIndex && lastIndex <= endIndex;
  });
  const durationSec = useReasoningDurationSec();
  return (
    <ReasoningRoot streaming={isReasoningStreaming}>
      <ReasoningTrigger active={isReasoningStreaming} duration={isReasoningStreaming ? undefined : durationSec} />
      <ReasoningContent aria-busy={isReasoningStreaming}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

export const ReasoningPart: FC<PropsWithChildren> = ({ children }) => {
  const isReasoningStreaming = useAuiState((s) => s.message.status?.type === "running" && s.message.parts[s.message.parts.length - 1]?.type === "reasoning");
  const durationSec = useReasoningDurationSec();
  return (
    <ReasoningRoot streaming={isReasoningStreaming}>
      <ReasoningTrigger active={isReasoningStreaming} duration={isReasoningStreaming ? undefined : durationSec} />
      <ReasoningContent aria-busy={isReasoningStreaming}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};
