"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CornerAction } from "@raceiq/lap-replay/contracts";
import { useCornerFocusController } from "@raceiq/lap-replay/ui";
import { Button } from "@/components/ui/button";
import { defaultComponents } from "@/components/assistant-ui/markdown-text";
import { linkifyCornerActions } from "./corner-action-linkify";

type MarkdownComponents = NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]>;

export function CornerActionMarkdown({ text, actions }: { text: string; actions: readonly CornerAction[] }) {
  const cornerFocus = useCornerFocusController();
  const markdown = useMemo(() => linkifyCornerActions(text, actions), [actions, text]);
  const actionByHref = useMemo(
    () => new Map(actions.map((action) => [`#corner-action-${encodeURIComponent(action.id)}`, action])),
    [actions],
  );
  const components: MarkdownComponents = {
    ...defaultComponents,
    a: ({ href, children }) => {
      const action = href ? actionByHref.get(href) : undefined;
      if (!action) return <a href={href} className="aui-md-a text-primary hover:text-primary/80 underline underline-offset-2">{children}</a>;
      return (
        <Button
          type="button"
          variant="link"
          data-corner-action={action.id}
          className="inline h-auto min-h-0 p-0 align-baseline text-app-accent underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-app-accent"
          aria-label={action.label}
          title={action.label}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            cornerFocus.focus(action, { loop: event.shiftKey });
          }}
        >
          {children}
        </Button>
      );
    },
  };
  return (
    <div className="aui-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
