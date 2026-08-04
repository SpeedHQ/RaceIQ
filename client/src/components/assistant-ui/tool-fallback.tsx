"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import { ToolFallbackApproval } from "./tool-fallback-approval";
import { ToolFallbackArgs, ToolFallbackContent, ToolFallbackError, ToolFallbackResult, ToolFallbackRoot, ToolFallbackTrigger } from "./tool-fallback-sections";

const ToolFallbackImpl: ToolCallMessagePartComponent = ({ toolName, argsText, result, status, addResult, resume, interrupt, approval, respondToApproval }) => {
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const isRequiresAction = status?.type === "requires-action";
  const [open, setOpen] = useState(isRequiresAction);
  const [prevRequiresAction, setPrevRequiresAction] = useState(isRequiresAction);
  if (isRequiresAction !== prevRequiresAction) {
    setPrevRequiresAction(isRequiresAction);
    if (isRequiresAction) setOpen(true);
  }
  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger toolName={toolName} status={status} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs argsText={argsText} className={cn(isCancelled && "opacity-60")} />
        {isRequiresAction && <ToolFallbackApproval addResult={addResult} resume={resume} interrupt={interrupt} approval={approval} respondToApproval={respondToApproval} />}
        {!isCancelled && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

export const ToolFallback = memo(ToolFallbackImpl) as ToolCallMessagePartComponent & { displayName?: string };
ToolFallback.displayName = "ToolFallback";
