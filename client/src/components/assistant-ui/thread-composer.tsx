"use client";

import { AuiIf, ComposerPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { ArrowUpIcon, MicIcon, SquareIcon } from "lucide-react";
import { type FC, useContext } from "react";
import { ComposerAddAttachment, ComposerAttachments } from "@/components/assistant-ui/attachment";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { ImageDisabledContext, ImageNoticeContext, InputDisabledContext } from "./thread-context";

export const Composer: FC = () => {
  const inputDisabled = useContext(InputDisabledContext);
  const imageDisabled = useContext(ImageDisabledContext);
  const imageNotice = useContext(ImageNoticeContext);
  const hasUnsupportedImage = useAuiState((s) => imageDisabled && s.composer.attachments.some((attachment) => attachment.type === "image"));
  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative flex w-full flex-col gap-1.5"
      onSubmitCapture={(event) => {
        if (hasUnsupportedImage) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onDropCapture={(event) => {
        if (imageDisabled && Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/"))) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onPasteCapture={(event) => {
        if (imageDisabled && Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"))) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {imageNotice && <p role="status" className="px-1 text-app-caption text-app-text-muted">{imageNotice}</p>}
      <ComposerPrimitive.AttachmentDropzone
        render={<div data-slot="aui_composer-shell" className="flex w-full flex-col gap-2 rounded-xl border border-border/60 bg-(--composer-bg) p-1.5 transition-colors focus-within:border-ring data-[dragging=true]:border-dashed data-[dragging=true]:border-ring data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]" />}
      >
        <ComposerAttachments />
        <div className="flex min-w-0 items-end gap-1.5">
          <ComposerPrimitive.Input
            placeholder={inputDisabled ? m.ai_chat_compacting() : m.ai_chat_send_message_placeholder()}
            className="aui-composer-input caret-primary placeholder:text-muted-foreground max-h-32 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none disabled:opacity-50 pointer-coarse:min-h-11"
            rows={1}
            autoFocus
            enterKeyHint="send"
            aria-label={m.ai_chat_message_input()}
            disabled={inputDisabled}
            onKeyDownCapture={(event) => {
              if (hasUnsupportedImage && event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          />
          <ComposerAction imageDisabled={imageDisabled} sendDisabled={hasUnsupportedImage} imageNotice={imageNotice} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{ imageDisabled: boolean; sendDisabled: boolean; imageNotice?: string }> = ({ imageDisabled, sendDisabled, imageNotice }) => {
  const isEmpty = useAuiState((s) => s.composer.isEmpty);
  return (
    <div className="aui-composer-action-wrapper flex shrink-0 items-center gap-1">
      {!imageDisabled && <ComposerAddAttachment />}
      <AuiIf condition={(s) => s.thread.capabilities.dictation}>
        <AuiIf condition={(s) => s.composer.dictation == null}>
          <ComposerPrimitive.Dictate render={<TooltipIconButton tooltip={m.ai_chat_voice_input()} side="bottom" type="button" variant="ghost" size="icon-sm" className="aui-composer-dictate" aria-label={m.ai_chat_start_voice_input()} />}><MicIcon className="aui-composer-dictate-icon size-4" /></ComposerPrimitive.Dictate>
        </AuiIf>
        <AuiIf condition={(s) => s.composer.dictation != null}>
          <ComposerPrimitive.StopDictation render={<TooltipIconButton tooltip={m.ai_chat_stop_dictation()} side="bottom" type="button" variant="destructive" size="icon-destructive" aria-label={m.ai_chat_stop_voice_input()} />}><SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" /></ComposerPrimitive.StopDictation>
        </AuiIf>
      </AuiIf>
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send render={<TooltipIconButton tooltip={sendDisabled && imageNotice ? imageNotice : m.ai_chat_send_message()} side="bottom" type="button" size="icon-lg" className="aui-composer-send border-transparent bg-app-accent text-app-on-filled hover:bg-app-accent-hover hover:text-app-on-filled disabled:bg-app-surface-alt disabled:text-app-text-muted pointer-coarse:size-11" aria-label={m.ai_chat_send_message()} disabled={isEmpty || sendDisabled} />}><ArrowUpIcon className="aui-composer-send-icon size-4.5" /></ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel render={<Button variant="default" size="icon-lg" className="aui-composer-cancel pointer-coarse:size-11" aria-label={m.ai_chat_stop_generating()} />}><SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" /></ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
};

export const EditComposer: FC = () => (
  <MessagePrimitive.Root data-slot="aui_edit-composer-wrapper" className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]">
    <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-none">
      <ComposerPrimitive.Input className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none" autoFocus />
      <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
        <ComposerPrimitive.Cancel render={<Button variant="ghost" size="sm" />}>{m.common_cancel()}</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send render={<Button size="sm" />}>{m.ai_chat_update()}</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </MessagePrimitive.Root>
);
