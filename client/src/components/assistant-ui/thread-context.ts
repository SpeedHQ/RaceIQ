"use client";

import type { MessagePrimitive, ToolCallMessagePartComponent } from "@assistant-ui/react";
import { type ComponentType, createContext, type PropsWithChildren } from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  ReasoningGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  inputDisabled?: boolean | undefined;
};

export const EMPTY_COMPONENTS: ThreadComponents = {};
export const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);
export const InputDisabledContext = createContext(false);
