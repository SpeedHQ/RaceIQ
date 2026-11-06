import { Button } from "@/components/ui/button";
import { splitCornerActionSpans, type CornerAction } from "@raceiq/lap-replay/contracts";
import { useCornerFocusController } from "@raceiq/lap-replay/ui";

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
  onFocus?: (action: CornerAction, options: { loop: boolean }) => void;
  disabled?: boolean;
}) {
  const cornerFocus = useCornerFocusController();
  const focus = onFocus ?? cornerFocus.focus;
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
            data-corner-action={part.action.id}
            data-corner-path={part.action.path}
            className="inline h-auto min-h-0 p-0 align-baseline text-app-accent underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-app-accent"
            aria-label={part.action.label}
            title={part.action.label}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              focus(part.action, { loop: event.shiftKey });
            }}
            onKeyDown={(event) => {
              // Handle both keys explicitly so Shift+Space does not depend on the
              // browser's synthetic click, which Playwright and some ATs omit.
              const space = event.code === "Space" || event.key === " " || event.key === "Space" || event.key === "Spacebar";
              if (event.key !== "Enter" && !space) return;
              event.preventDefault();
              event.stopPropagation();
              focus(part.action, { loop: event.shiftKey });
            }}
            onKeyUp={(event) => {
              const space = event.code === "Space" || event.key === " " || event.key === "Space" || event.key === "Spacebar";
              if (event.key !== "Enter" && !space) return;
              // Base UI can consume the Space keydown before the activation
              // reaches the button in some browsers; keyup is the fallback.
              event.preventDefault();
              event.stopPropagation();
              focus(part.action, { loop: event.shiftKey });
            }}
          >
            {part.action.label}
          </Button>
        ),
      )}
    </>
  );
}
