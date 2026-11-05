import { Button } from "@/components/ui/button";
import { splitCornerActionSpans, type CornerAction } from "@raceiq/lap-replay/contracts";

/**
 * Renders AI analysis text with schema-validated corner references inline
 * (SpeedHQ/RaceIQ#515). Text around the references stays untouched.
 */
export function CornerActionText({
  text,
  actions,
  onFocus,
  disabled,
}: {
  text: string;
  actions?: readonly CornerAction[];
  onFocus: (action: CornerAction, options: { loop: boolean }) => void;
  disabled?: boolean;
}) {
  if (!actions || actions.length === 0) return <>{text}</>;
  return (
    <>
      {splitCornerActionSpans(text, actions).map((part, index) =>
        part.kind === "text" ? (
          <span key={`t${index}`}>{part.text}</span>
        ) : (
          <Button
            key={`a${index}`}
            type="button"
            variant="link"
            disabled={disabled}
            className="inline h-auto min-h-0 p-0 align-baseline text-app-accent underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-app-accent"
            aria-label={part.action.label}
            title={part.action.label}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onFocus(part.action, { loop: event.shiftKey });
            }}
            onKeyDown={(event) => {
              // Space activates through the native Button click; handling it here
              // would preventDefault the click and swallow the activation.
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
              onFocus(part.action, { loop: event.shiftKey });
            }}
          >
            {text.slice(part.action.span.start, part.action.span.end)}
          </Button>
        ),
      )}
    </>
  );
}
