"use client";

import type { ToolApprovalOption, ToolCallMessagePart, ToolCallMessagePartProps } from "@assistant-ui/react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const APPROVED_RESULT = "Approved by user";
const DENIED_RESULT = "User denied tool execution";
const APPROVAL_OPTION_DEFAULT_LABELS: Record<string, string> = { "allow-once": "Allow", "allow-always": "Always allow", "reject-once": "Deny", "reject-always": "Always deny" };
const isAllowKind = (kind: string) => kind === "allow-once" || kind === "allow-always";
const approvalOptionLabel = (option: ToolApprovalOption) =>
  option.label ?? (Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, option.kind) ? APPROVAL_OPTION_DEFAULT_LABELS[option.kind] : undefined) ?? option.id;

export function ToolFallbackApproval({
  className,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  ...props
}: React.ComponentProps<"div"> &
  Partial<Pick<ToolCallMessagePartProps, "addResult" | "resume" | "respondToApproval">> & { interrupt?: ToolCallMessagePart["interrupt"]; approval?: ToolCallMessagePart["approval"] }) {
  const [submitted, setSubmitted] = React.useState(false);
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null);
  if (approval != null && (approval.approved !== undefined || approval.resolution !== undefined)) return null;
  const declaredOptions = respondToApproval ? approval?.options : undefined;
  const options = declaredOptions?.filter((o) => Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, o.kind));
  const respond = (approved: boolean) => {
    if (submitted) return;
    if (approval != null && approval.approved === undefined && respondToApproval) respondToApproval({ approved });
    else if (interrupt) resume?.({ approved });
    else addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT);
    setSubmitted(true);
  };
  const respondWithOption = (option: ToolApprovalOption) => {
    if (submitted) return;
    respondToApproval?.({ optionId: option.id });
    setSubmitted(true);
    setConfirmingId(null);
  };
  const handleOption = (option: ToolApprovalOption) => {
    if (option.confirm) setConfirmingId(option.id);
    else respondWithOption(option);
  };
  const confirming = confirmingId != null ? options?.find((o) => o.id === confirmingId) : undefined;
  if (confirming) {
    const confirmMeta = typeof confirming.confirm === "object" ? confirming.confirm : undefined;
    const confirmDescription = confirmMeta?.description ?? confirming.description;
    return (
      <div data-slot="tool-fallback-approval-confirm" className={cn("aui-tool-fallback-approval-confirm flex flex-col gap-2 pt-1", className)} {...props}>
        <p className="aui-tool-fallback-approval-confirm-title font-semibold">{confirmMeta?.title ?? `${approvalOptionLabel(confirming)}?`}</p>
        {confirmDescription && <p className="aui-tool-fallback-approval-confirm-description text-muted-foreground">{confirmDescription}</p>}
        {confirming.grants && confirming.grants.length > 0 && (
          <ul className="aui-tool-fallback-approval-confirm-grants flex flex-col gap-1">
            {confirming.grants.map((grant) => (
              <li key={grant}>
                <code className="aui-tool-fallback-approval-confirm-grant bg-muted rounded px-1.5 py-0.5 text-xs">{grant}</code>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => respondWithOption(confirming)} disabled={submitted}>
            Confirm
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirmingId(null)} disabled={submitted}>
            Back
          </Button>
        </div>
      </div>
    );
  }
  if (declaredOptions && declaredOptions.length > 0) {
    const allowOptions = options?.filter((o) => isAllowKind(o.kind)) ?? [];
    const rejectOptions = options?.filter((o) => !isAllowKind(o.kind)) ?? [];
    return (
      <div data-slot="tool-fallback-approval" className={cn("aui-tool-fallback-approval flex flex-wrap items-center gap-2 pt-1", className)} {...props}>
        {[...allowOptions, ...rejectOptions].map((option) => (
          <Button key={option.id} size="sm" variant={option === allowOptions[0] ? "default" : "outline"} onClick={() => handleOption(option)} disabled={submitted}>
            {approvalOptionLabel(option)}
          </Button>
        ))}
        {rejectOptions.length === 0 && (
          <Button size="sm" variant="outline" onClick={() => respond(false)} disabled={submitted}>
            Deny
          </Button>
        )}
      </div>
    );
  }
  return (
    <div data-slot="tool-fallback-approval" className={cn("aui-tool-fallback-approval flex items-center gap-2 pt-1", className)} {...props}>
      <Button size="sm" onClick={() => respond(true)} disabled={submitted}>
        Allow
      </Button>
      <Button size="sm" variant="outline" onClick={() => respond(false)} disabled={submitted}>
        Deny
      </Button>
    </div>
  );
}
