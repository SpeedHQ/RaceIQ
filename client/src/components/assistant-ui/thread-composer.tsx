"use client";

import { AuiIf, ComposerPrimitive, MessagePrimitive } from "@assistant-ui/react";
import { ArrowUpIcon, MicIcon, SquareIcon } from "lucide-react";
import { type FC, useContext } from "react";
import { ComposerAddAttachment, ComposerAttachments } from "@/components/assistant-ui/attachment";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { InputDisabledContext } from "./thread-context";

export const Composer: FC = () => {
  const inputDisabled = useContext(InputDisabledContext);
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone
        render={
          <div
            data-slot="aui_composer-shell"
            className="border-border/60 data-[dragging=true]:border-ring focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-none transition-colors data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
          />
        }
      >
        <ComposerAttachments />
        <ComposerPrimitive.Input
          placeholder={inputDisabled ? "Compacting…" : "Send a message..."}
          className="aui-composer-input caret-primary placeholder:text-muted-foreground/80 max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none disabled:opacity-50"
          rows={1}
          autoFocus
          enterKeyHint="send"
          aria-label="Message input"
          disabled={inputDisabled}
        />
        <ComposerAction />
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => (
  <div className="aui-composer-action-wrapper relative flex items-center justify-between">
    <ComposerAddAttachment />
    <div className="flex items-center gap-1.5">
      <AuiIf condition={(s) => s.thread.capabilities.dictation}>
        <AuiIf condition={(s) => s.composer.dictation == null}>
          <ComposerPrimitive.Dictate
            render={<TooltipIconButton tooltip="Voice input" side="bottom" type="button" variant="ghost" size="icon-sm" className="aui-composer-dictate" aria-label="Start voice input" />}
          >
            <MicIcon className="aui-composer-dictate-icon size-4" />
          </ComposerPrimitive.Dictate>
        </AuiIf>
        <AuiIf condition={(s) => s.composer.dictation != null}>
          <ComposerPrimitive.StopDictation
            render={<TooltipIconButton tooltip="Stop dictation" side="bottom" type="button" variant="destructive" size="icon-destructive" aria-label="Stop voice input" />}
          >
            <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
          </ComposerPrimitive.StopDictation>
        </AuiIf>
      </AuiIf>
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send
          render={<TooltipIconButton tooltip="Send message" side="bottom" type="button" variant="default" size="icon-sm" className="aui-composer-send" aria-label="Send message" />}
        >
          <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel render={<Button variant="default" size="icon-sm" className="aui-composer-cancel" aria-label="Stop generating" />}>
          <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  </div>
);

export const EditComposer: FC = () => (
  <MessagePrimitive.Root data-slot="aui_edit-composer-wrapper" className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]">
    <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-none">
      <ComposerPrimitive.Input className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none" autoFocus />
      <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
        <ComposerPrimitive.Cancel render={<Button variant="ghost" size="sm" />}>Cancel</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send render={<Button size="sm" />}>Update</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </MessagePrimitive.Root>
);
