import { m } from "@/paraglide/messages";
import { type ExperimentVersion, useExperimentFocusHistory } from "../../hooks/experiments";
import { parseUtcTimestamp } from "@/lib/utc-date";

/**
 * The experiment's focus ledger, oldest first — what the driver was working on,
 * when it changed, and (when they said) why.
 *
 * `experiments.focus` alone only answers "what now". A session that went car →
 * driver → car reads as a flat list of arms without this: you cannot tell that
 * v4–v5 were drills run because the balance was already sorted. Each switch
 * records the head version it happened at, so an era can name where in the
 * version tree it began.
 *
 * Reads as eras rather than clicks: a no-op re-select writes nothing server-side
 * (see setExperimentFocus), so every row here is a real change of direction.
 */
export function FocusTimeline({ experimentId, versions = [] }: { experimentId: number; versions?: ExperimentVersion[] }) {
  const { data: events = [], isLoading } = useExperimentFocusHistory(experimentId);

  if (isLoading) return <div className="text-app-compact text-app-text-dim">{m.tunes_loading_focus_history()}</div>;
  // One entry means the experiment opened on a focus and never moved — a
  // timeline of one is noise, so say the plain fact instead.
  if (events.length <= 1) {
    const only = events[0];
    return (
      <div className="text-app-compact text-app-text-dim">
        {only ? m.tunes_focus_unchanged({ focus: (only.focus === "driver" ? m.experiment_focus_driver() : m.experiment_focus_setup()).toLowerCase() }) : m.tunes_no_focus_history()}
      </div>
    );
  }

  const labelFor = (versionId: number | null) => versions.find((v) => v.id === versionId)?.label ?? null;

  return (
    <ol className="flex flex-col gap-1.5">
      {events.map((e, i) => {
        const at = labelFor(e.fromVersionId);
        return (
          <li key={e.id} className="flex items-start gap-2 text-app-compact">
            <span
              className={`mt-px rounded-full px-1.5 py-px text-app-caption font-medium shrink-0 ${
                e.focus === "driver" ? "bg-(--focus-driver)/15 text-(--focus-driver)" : "bg-(--focus-setup)/15 text-(--focus-setup)"
              }`}
            >
              {e.focus === "driver" ? m.experiment_focus_driver() : m.experiment_focus_setup()}
            </span>
            <div className="min-w-0">
              <span className="text-app-text-dim">
                {i === 0 ? m.tunes_focus_opened() : m.tunes_focus_switched()}
                {at ? ` ${m.tunes_focus_at({ version: at })}` : ""} · {parseUtcTimestamp(e.createdAt).toLocaleString()}
              </span>
              {/* Only ever the driver's own words — never inferred. */}
              {e.note && <div className="text-app-text">“{e.note}”</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
