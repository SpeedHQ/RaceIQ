import { m } from "@/paraglide/messages";
import { EXPERIMENT_FOCUSES, type ExperimentFocus } from "@raceiq/shared/racing/experiments/focus";
import { useEffect, useRef, useState } from "react";
import { AppInput } from "@/components/ui/AppInput";
import { useSetExperimentFocus } from "../../hooks/experiments";
import { Button } from "../ui/button";

/**
 * Switch what an experiment is working on, mid-session.
 *
 * The driver fixes a balance problem, then wants to work on braking — same car,
 * same track, same experiment. So this is a mode toggle, not a setting buried in
 * an edit dialog, and it sits in the workspace header where the change of intent
 * actually happens.
 *
 * Switching asks for an optional reason because the switch is appended to the
 * experiment's focus ledger and that entry is immutable — there is no later
 * moment at which the note could be added. It stays optional: an unexplained
 * switch is recorded honestly as unexplained rather than blocked or invented.
 */
export function FocusSwitcher({ experimentId, focus }: { experimentId: number; focus: ExperimentFocus }) {
  const setFocus = useSetExperimentFocus();
  const [pending, setPending] = useState<ExperimentFocus | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  // Focus the note field when the popover opens. A ref + effect rather than the
  // `autoFocus` attribute: autoFocus fires on mount regardless of context, which
  // is what the a11y rule objects to; this only steals focus at the moment the
  // driver deliberately opened the dialog.
  useEffect(() => {
    if (pending) noteRef.current?.focus();
  }, [pending]);

  const commit = async () => {
    if (!pending) return;
    setError(null);
    try {
      await setFocus.mutateAsync({ id: experimentId, focus: pending, note: note.trim() || null });
      setPending(null);
      setNote("");
    } catch (err: any) {
      setError(err?.message ?? m.experiment_focus_switch_error());
    }
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <span className="text-app-caption uppercase tracking-wider text-app-text-muted">{m.experiment_working_on()}</span>
        {/* fieldset rather than role="group": the native element carries the
            grouping semantics, and the legend names it for screen readers. */}
        <fieldset className="flex rounded-md border border-app-border overflow-hidden">
        <legend className="sr-only">{m.experiment_focus_legend()}</legend>
          {EXPERIMENT_FOCUSES.map((f) => {
            const active = focus === f;
            return (
              <Button
                key={f}
                variant={active ? (f === "driver" ? "focus-toggle-driver" : "focus-toggle-setup") : "focus-toggle"}
                size="app-sm"
                aria-pressed={active}
                title={f === "driver" ? m.experiment_focus_driver_hint() : m.experiment_focus_setup_hint()}
                onClick={() => {
                  // Re-picking the active focus is a no-op server-side; don't
                  // open a dialog that would record nothing.
                  if (active) return;
                  setPending(f);
                  setNote("");
                }}
              >
                {f === "driver" ? m.experiment_focus_driver() : m.experiment_focus_setup()}
              </Button>
            );
          })}
        </fieldset>
      </div>

      {pending && (
        <div className="absolute right-0 z-20 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-app-border bg-app-surface p-3 shadow-xl">
          <p className="text-xs text-app-text">
            {m.experiment_switch_to()} <span className="font-semibold">{pending === "driver" ? m.experiment_focus_driver() : m.experiment_focus_setup()}</span>
          </p>
          <p className="mt-1 text-app-compact text-app-text-dim">{pending === "driver" ? m.experiment_focus_driver_hint() : m.experiment_focus_setup_hint()}</p>
          <p className="mt-1 text-app-compact text-app-text-dim">{m.experiment_focus_versions_note()}</p>
          <AppInput
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") setPending(null);
            }}
            placeholder={m.experiment_focus_reason_placeholder()}
            maxLength={2000}
            ref={noteRef}
            className="mt-2 w-full text-xs"
          />
          {error && <div className="mt-1.5 text-app-compact text-status-danger">{error}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="app-outline" size="app-sm" onClick={() => setPending(null)}>
              {m.common_cancel()}
            </Button>
            <Button variant="app-primary" size="app-sm" onClick={() => void commit()} disabled={setFocus.isPending}>
              {setFocus.isPending ? m.experiment_switching() : m.experiment_switch()}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
