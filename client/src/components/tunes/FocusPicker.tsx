import { EXPERIMENT_FOCUS_HINTS, EXPERIMENT_FOCUS_LABELS, EXPERIMENT_FOCUSES, type ExperimentFocus } from "@shared/experiment-focus";
import { Button } from "../ui/button";

/**
 * Pick what a NEW experiment starts by varying — the car or the driver.
 *
 * Game-agnostic on purpose. Focus is a property of an experiment, not of a
 * game: every game's new-experiment modal offers the same choice, and the only
 * thing that differs per game is what a base setup looks like (a file for
 * ACC/AC-EVO, a telemetry capture for F1). An earlier cut inlined this markup
 * inside the ACC/AC-EVO modal, which silently meant F1 experiments could only
 * ever open on the car.
 *
 * Presented as a starting mode rather than a type, because it is switchable
 * from the workspace at any point (see FocusSwitcher) — nothing here is a
 * commitment.
 */
export function FocusPicker({
  value,
  onChange,
  label = "Start by varying",
}: {
  value: ExperimentFocus;
  onChange: (focus: ExperimentFocus) => void;
  /** Overridable so a game whose flow needs different wording can supply it. */
  label?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-app-compact text-app-text-muted uppercase tracking-wider">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        {EXPERIMENT_FOCUSES.map((f) => (
          <Button
            key={f}
            variant={value === f ? "focus-option-selected" : "focus-option"}
            size="app-md"
            onClick={() => onChange(f)}
            aria-pressed={value === f}
          >
            <div className="text-xs font-semibold text-app-text">{EXPERIMENT_FOCUS_LABELS[f]}</div>
            <div className="mt-0.5 text-app-compact text-app-text-dim">{EXPERIMENT_FOCUS_HINTS[f]}</div>
          </Button>
        ))}
      </div>
      <p className="text-app-compact text-app-text-dim">You can switch focus later without starting a new experiment.</p>
    </div>
  );
}
