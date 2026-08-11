"use client";

import { ActionBarMorePrimitive, ActionBarPrimitive, AuiIf, BranchPickerPrimitive, ErrorPrimitive, groupPartByType, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, DownloadIcon, MoreHorizontalIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import { type FC, useContext } from "react";
import { UserMessageAttachments } from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "@/components/assistant-ui/tool-group";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";

import { cn } from "@/lib/utils";
import { EditComposer } from "./thread-composer";
import { RegenerateContext, ThreadComponentsContext } from "./thread-context";
import { ReasoningGroupFallback, ReasoningPart } from "./thread-reasoning";

export const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } = useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const MessageError: FC = () => (
  <MessagePrimitive.Error>
    <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm">
      <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
    </ErrorPrimitive.Root>
  </MessagePrimitive.Error>
);

const AssistantMessage: FC = () => {
  const { Text: TextComponent, ToolFallback: ToolFallbackComponent = ToolFallback, ToolGroup, ReasoningGroup } = useContext(ThreadComponentsContext);
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;
  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div data-slot="aui_assistant-message-content" className="text-foreground px-2 leading-relaxed wrap-break-word">
        <MessagePrimitive.GroupedParts groupBy={groupPartByType({ reasoning: [], "tool-call": ["group-chainOfThought", "group-tool"], "standalone-tool-call": [] })}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) return <ToolGroup group={part}>{children}</ToolGroup>;
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger count={part.indices.length} active={part.status.type === "running"} />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning":
                return ReasoningGroup ? <ReasoningGroup group={part}>{children}</ReasoningGroup> : <ReasoningGroupFallback group={part}>{children}</ReasoningGroupFallback>;
              case "text":
                return TextComponent ? <TextComponent {...part} /> : <MarkdownText />;
              case "reasoning":
                return (
                  <ReasoningPart>
                    <MarkdownText />
                  </ReasoningPart>
                );
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    role="status"
                    className="animate-pulse font-sans inline-flex items-center gap-1.5 text-app-text-muted"
                    aria-label="Assistant is working"
                  >
                    {"●"}
                    <span>Engineer working…</span>
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>
      <div data-slot="aui_assistant-message-footer" className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}>
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200">
    <ActionBarPrimitive.Copy render={<TooltipIconButton tooltip="Copy" />}>
      <AuiIf condition={(s) => s.message.isCopied}>
        <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
      </AuiIf>
      <AuiIf condition={(s) => !s.message.isCopied}>
        <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
      </AuiIf>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload render={<TooltipIconButton tooltip="Refresh" />}>
      <RefreshCwIcon />
    </ActionBarPrimitive.Reload>
    <ActionBarMorePrimitive.Root>
      <ActionBarMorePrimitive.Trigger render={<TooltipIconButton tooltip="More" />}>
        <MoreHorizontalIcon />
      </ActionBarMorePrimitive.Trigger>
      <ActionBarMorePrimitive.Content
        side="bottom"
        align="start"
        sideOffset={6}
        className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
      >
        <ActionBarPrimitive.ExportMarkdown
          render={
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none" />
          }
        >
          <DownloadIcon className="size-4" />
          Export as Markdown
        </ActionBarPrimitive.ExportMarkdown>
      </ActionBarMorePrimitive.Content>
    </ActionBarMorePrimitive.Root>
  </ActionBarPrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root
    data-slot="aui_user-message-root"
    className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
    data-role="user"
  >
    <UserMessageAttachments />
    <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
      <div className="aui-user-message-content peer bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden">
        <MessagePrimitive.Parts />
      </div>
      <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
        <UserActionBar />
      </div>
    </div>
    <BranchPicker data-slot="aui_user-branch-picker" className="col-span-full col-start-1 row-start-3 -me-1 justify-end" />
  </MessagePrimitive.Root>
);

const UserActionBar: FC = () => {
  const onRegenerate = useContext(RegenerateContext);
  const messageId = useAuiState((s) => s.message.id);
  const prompt = useAuiState((s) =>
    s.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  );
  return (
    <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="aui-user-action-bar-root flex flex-col items-end">
      {onRegenerate && (
        <TooltipIconButton tooltip="Regenerate" className="aui-user-action-regenerate" onClick={() => onRegenerate(messageId, prompt)} aria-label="Regenerate">
          <RefreshCwIcon />
        </TooltipIconButton>
      )}
      <ActionBarPrimitive.Edit render={<TooltipIconButton tooltip="Edit" className="aui-user-action-edit" />}>
        <PencilIcon />
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({ className, ...rest }) => (
  <BranchPickerPrimitive.Root hideWhenSingleBranch className={cn("aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs", className)} {...rest}>
    <BranchPickerPrimitive.Previous render={<TooltipIconButton tooltip="Previous" />}>
      <ChevronLeftIcon />
    </BranchPickerPrimitive.Previous>
    <span className="aui-branch-picker-state font-medium">
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
    </span>
    <BranchPickerPrimitive.Next render={<TooltipIconButton tooltip="Next" />}>
      <ChevronRightIcon />
    </BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
);
