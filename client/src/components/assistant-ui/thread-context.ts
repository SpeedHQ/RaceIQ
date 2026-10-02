"use client";

import type { MessagePrimitive, TextMessagePartComponent, ToolCallMessagePartComponent } from "@assistant-ui/react";
import { type ComponentType, createContext, type PropsWithChildren } from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  Text?: TextMessagePartComponent | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  ReasoningGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  inputDisabled?: boolean | undefined;
  onRegenerate?: ((messageId: string, prompt: string) => void) | undefined;
};

export const EMPTY_COMPONENTS: ThreadComponents = {};
export const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);
export const RegenerateContext = createContext<((messageId: string, prompt: string) => void) | undefined>(undefined);
export const InputDisabledContext = createContext(false);
