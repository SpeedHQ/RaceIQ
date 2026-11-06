import type { CornerAction } from "@raceiq/lap-replay/contracts";
import { splitCornerActionSpans } from "@raceiq/lap-replay/contracts";

function escapeLinkText(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

/** Turn validated action spans into Markdown links for the chat renderer. */
export function linkifyCornerActions(text: string, actions: readonly CornerAction[]): string {
  return splitCornerActionSpans(text, actions)
    .map((part) =>
      part.kind === "text"
        ? part.text
        : `[${escapeLinkText(part.action.label)}](#corner-action-${encodeURIComponent(part.action.id)})`,
    )
    .join("");
}
