import type { SessionDownsampleSkip } from "@raceiq/shared/racing/sessions/downsample";
import { m } from "@/paraglide/messages";

type Reason = SessionDownsampleSkip["reason"];

export function sessionDownsampleSkipLabel(reason: Reason) {
  switch (reason) {
    case "favorite":
      return m.storage_downsample_skip_favorite();
    case "shared-age-conflict":
      return m.storage_downsample_skip_shared_age_conflict();
    case "missing":
      return m.storage_downsample_skip_missing();
    case "unowned":
      return m.storage_downsample_skip_unowned();
    case "unsupported-format":
      return m.storage_downsample_skip_unsupported_format();
    case "unreliable-time":
      return m.storage_downsample_skip_unreliable_time();
    case "already-at-or-below-target":
      return m.storage_downsample_skip_already_at_or_below_target();
    case "not-smaller":
      return m.storage_downsample_skip_not_smaller();
  }
}

export function SessionDownsampleSkipSummary({ skips, title }: { skips: SessionDownsampleSkip[]; title: string }) {
  const totals = new Map<Reason, number>();
  for (const skip of skips) totals.set(skip.reason, (totals.get(skip.reason) ?? 0) + skip.sessionIds.length);
  if (totals.size === 0) return null;
  return (
    <div>
      <p className="text-sm font-medium">{title}</p>
      <ul className="text-sm text-app-text-secondary">
        {Array.from(totals, ([reason, count]) => (
          <li key={reason}>{m.storage_downsample_skip_summary({ reason: sessionDownsampleSkipLabel(reason), count })}</li>
        ))}
      </ul>
    </div>
  );
}
