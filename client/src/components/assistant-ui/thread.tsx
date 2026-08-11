"use client";

import { type AssistantState, AuiIf, SuggestionPrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { type FC, useContext } from "react";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/follow-up-suggestions";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Composer } from "./thread-composer";
import { EMPTY_COMPONENTS, InputDisabledContext, RegenerateContext, type ThreadComponents, ThreadComponentsContext, type ThreadGroupPart, type ThreadProps } from "./thread-context";
import { ThreadMessage } from "./thread-message";

export type { ThreadComponents, ThreadGroupPart, ThreadProps };

const isNewChatView = (s: AssistantState) => s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading);

export const Thread: FC<ThreadProps> = ({ components = EMPTY_COMPONENTS, inputDisabled = false, onRegenerate }) => {
  const isEmpty = useAuiState(isNewChatView);
  return (
    <ThreadComponentsContext.Provider value={components}>
      <RegenerateContext.Provider value={onRegenerate}>
        <InputDisabledContext.Provider value={inputDisabled}>
          <ThreadRoot isEmpty={isEmpty} />
        </InputDisabledContext.Provider>
      </RegenerateContext.Provider>
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]: "color-mix(in oklab, var(--color-muted) 30%, var(--color-background))",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport turnAnchor="top" data-slot="aui_thread-viewport" className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth">
        <div className={cn("mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4", isEmpty && "justify-center")}>
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <div data-slot="aui_message-group" className="mb-14 flex flex-col gap-y-6 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter
            className={cn("aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 @md:pb-6", !isEmpty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)")}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            <Composer />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadWelcome: FC = () => (
  <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
    <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">How can I help you today?</h1>
  </div>
);
const ThreadSuggestions: FC = () => (
  <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
    <ThreadPrimitive.Suggestions>{() => <ThreadSuggestionItem />}</ThreadPrimitive.Suggestions>
  </div>
);
const ThreadSuggestionItem: FC = () => (
  <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
    <SuggestionPrimitive.Trigger send render={<Button variant="ghost" size="app-md" className="aui-thread-welcome-suggestion" />}>
      <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
      <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
    </SuggestionPrimitive.Trigger>
  </div>
);
const ThreadScrollToBottom: FC = () => (
  <ThreadPrimitive.ScrollToBottom
    render={<TooltipIconButton tooltip="Scroll to bottom" variant="outline" className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center disabled:invisible" />}
  />
);
