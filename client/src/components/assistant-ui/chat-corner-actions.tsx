"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { parseCornerActions, type CornerAction } from "@raceiq/lap-replay/contracts";
import { ToolFallback } from "./tool-fallback";

type ChatCornerActionsState = {
  actions: readonly CornerAction[];
  setActions: (actions: readonly CornerAction[]) => void;
};

const ChatCornerActionsContext = createContext<ChatCornerActionsState | null>(null);

export function ChatCornerActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<readonly CornerAction[]>([]);
  const value = useMemo(() => ({ actions, setActions }), [actions]);
  return <ChatCornerActionsContext.Provider value={value}>{children}</ChatCornerActionsContext.Provider>;
}

export function useChatCornerActions(): readonly CornerAction[] {
  return useContext(ChatCornerActionsContext)?.actions ?? [];
}

function actionPayload(result: unknown): unknown[] | undefined {
  if (typeof result === "string") {
    try {
      return actionPayload(JSON.parse(result));
    } catch {
      return undefined;
    }
  }
  if (result && typeof result === "object" && "actions" in result) {
    return (result as { actions?: unknown[] }).actions;
  }
  return undefined;
}

function CornerActionsToolPart({ result }: { result: unknown }) {
  const context = useContext(ChatCornerActionsContext);
  const actions = useMemo(() => parseCornerActions(actionPayload(result)), [result]);
  useEffect(() => {
    context?.setActions(actions);
  }, [actions, context]);
  return null;
}

/** Routes the hidden action side-channel and leaves every other tool unchanged. */
export const ChatCornerActionsTool: ToolCallMessagePartComponent = (props) => {
  if (props.toolName !== "corner_actions") return <ToolFallback {...props} />;
  return <CornerActionsToolPart result={props.result} />;
};
