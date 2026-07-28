import { EXPERIMENT_FOCUS_HINTS, EXPERIMENT_FOCUS_LABELS, EXPERIMENT_FOCUSES, type ExperimentFocus } from "@shared/experiment-focus";
import { useEffect, useRef, useState } from "react";
import { useSetExperimentFocus } from "../../hooks/queries";

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
      setError(err?.message ?? "Couldn't switch focus");
    }
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-app-text-muted">Working on</span>
        {/* fieldset rather than role="group": the native element carries the
            grouping semantics, and the legend names it for screen readers. */}
        <fieldset className="flex rounded-md border border-app-border overflow-hidden">
          <legend className="sr-only">Experiment focus</legend>
          {EXPERIMENT_FOCUSES.map((f) => {
            const active = focus === f;
            return (
              <button
                key={f}
                type="button"
                aria-pressed={active}
                title={EXPERIMENT_FOCUS_HINTS[f]}
                onClick={() => {
                  // Re-picking the active focus is a no-op server-side; don't
                  // open a dialog that would record nothing.
                  if (active) return;
                  setPending(f);
                  setNote("");
                }}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? f === "driver"
                      ? "bg-sky-500/20 text-sky-200 font-semibold"
                      : "bg-purple-500/20 text-purple-200 font-semibold"
                    : "text-app-text-dim hover:text-app-text hover:bg-app-border/30"
                }`}
              >
                {EXPERIMENT_FOCUS_LABELS[f]}
              </button>
            );
          })}
        </fieldset>
      </div>

      {pending && (
        <div className="absolute right-0 z-20 mt-2 w-[320px] rounded-lg border border-app-border bg-app-surface p-3 shadow-xl">
          <p className="text-xs text-app-text">
            Switch to <span className="font-semibold">{EXPERIMENT_FOCUS_LABELS[pending]}</span>
          </p>
          <p className="mt-1 text-[11px] text-app-text-dim">{EXPERIMENT_FOCUS_HINTS[pending]}</p>
          <p className="mt-1 text-[11px] text-app-text-dim">Versions you've already run keep what they were.</p>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") setPending(null);
            }}
            placeholder="Why the switch? (optional)"
            maxLength={2000}
            ref={noteRef}
            className="mt-2 w-full bg-app-bg border border-app-border rounded px-2 py-1.5 text-xs"
          />
          {error && <div className="mt-1.5 text-[11px] text-red-400">{error}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setPending(null)} className="px-2 py-1 text-[11px] rounded border border-app-border text-app-text-dim hover:text-app-text">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void commit()}
              disabled={setFocus.isPending}
              className="px-2.5 py-1 text-[11px] rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-semibold"
            >
              {setFocus.isPending ? "Switching…" : "Switch"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
