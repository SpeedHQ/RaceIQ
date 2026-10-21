import type { DriverSummary, ProfileCoverage } from "@raceiq/online/contracts";
import { DriverSummaryBuilding, useLocalDriverSummary, useOnlineProfile } from "@/hooks/online-activity";
import { onlineErrorMessage } from "@/components/online/messages";
import { OnlineTimestamp } from "@/components/online/OnlineTimestamp";
import { Button } from "@/components/ui/button";
import { uiStore } from "@/stores/ui";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

export function OnlineDriverSummary({ gameId, from, to }: { gameId: string | null; from: string; to: string }) {
  const local = useLocalDriverSummary({ gameId, from, to });
  const profile = useOnlineProfile();
  const remote = profile.data;
  const stale = profile.isError || profile.online.isCachedState || !!profile.online.transportError || remote?.status === "unavailable";
  return <section className="space-y-3" aria-label={m.online_summary_title()}>
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <section className="min-w-0 rounded-md border border-app-border p-4 text-sm" aria-label={m.online_summary_local()}>
        <h2 className="font-semibold text-app-text">{m.online_summary_local()}</h2>
        <p className="mt-1 text-app-text-muted">{m.online_summary_local_scope()}</p>
        {local.isPending && <p role="status">{m.common_loading()}</p>}
        {local.isError && <p role="status">{local.error instanceof DriverSummaryBuilding ? m.online_summary_building() : m.online_queue_unavailable()}</p>}
        {local.data && <><SummaryValues summary={local.data.summary} coverage={local.data.coverage} />
          <details className="mt-3 border-t border-app-border pt-3"><summary className="cursor-pointer font-medium">{m.online_summary_context()}</summary>
            <p className="mt-2 text-app-text-muted">{m.online_summary_context_note()}</p>
            <dl className="mt-2 space-y-1">{(["other", "mixed", "unknown"] as const).map((kind) => <div key={kind} className="flex flex-wrap justify-between gap-2"><dt>{kind === "other" ? m.online_attribution_other() : kind === "mixed" ? m.online_attribution_mixed() : m.online_attribution_unknown()}</dt><dd>{m.online_summary_context_value({ laps: local.data.context[kind].laps, seconds: new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(local.data.context[kind].seconds) })}</dd></div>)}</dl>
          </details></>}
      </section>
      <section className="min-w-0 rounded-md border border-app-border p-4 text-sm" aria-label={m.online_summary_lifetime()}>
        <h2 className="font-semibold text-app-text">{m.online_summary_lifetime()}</h2>
        <p className="mt-1 text-app-text-muted">{m.online_summary_lifetime_scope()}</p>
        {profile.isPending && !remote && <p role="status">{m.online_loading()}</p>}
        {stale && <p role="status" className="mt-2 text-status-warning">{m.online_summary_stale()}</p>}
        {!remote && !profile.isPending && <p role="status">{m.online_queue_unavailable()}</p>}
        {remote?.status === "signed_out" && <p role="status">{m.online_block_signed_out()}</p>}
        {remote?.status === "consent_required" && <p role="status">{m.online_error_consent_required()}</p>}
        {remote?.status === "unavailable" && <p role="status">{m.online_queue_unavailable()}</p>}
        {remote?.status === "syncing" && <p role="status">{m.online_summary_syncing()}</p>}
        {remote?.status === "legacy_unverified" && <div className="mt-3 border-l-2 border-status-warning pl-3"><h3 className="font-medium">{m.online_summary_legacy()}</h3><p className="mt-1 text-app-text-muted">{m.online_summary_legacy_note()}</p>{remote.legacyStats && <dl className="mt-2 grid grid-cols-2 gap-2"><div><dt>{m.recap_laps()}</dt><dd>{remote.legacyStats.totalLaps}</dd></div><div><dt>{m.online_summary_driving_time()}</dt><dd>{m.online_summary_seconds({ seconds: new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(remote.legacyStats.drivingTimeSeconds) })}</dd></div></dl>}</div>}
        {remote?.summary && remote.status !== "legacy_unverified" && <SummaryValues summary={remote.summary} coverage={remote.coverage} />}
        {remote?.status === "ready" && !remote.summary && <p role="status">{m.online_queue_unknown()}</p>}
        {remote && <><p className="mt-3">{m.online_profile_sync_counts({ pending: remote.localPending, held: remote.heldAmbiguous })}</p><p className="mt-1">{m.online_profile_revision()}: {remote.onlineRevision ?? m.online_queue_unknown()}</p><p>{m.online_profile_confirmed()}: <OnlineTimestamp value={remote.lastConfirmedAt} /></p>{remote.error && <p role="alert" className="mt-2 text-status-danger">{onlineErrorMessage(remote.error.code)}</p>}</>}
      </section>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-app-text-muted"><p className="max-w-3xl">{m.online_summary_aggregate_note()}</p><Button variant="outline" size="sm" onClick={() => uiStore.actions.openSettings("upload")}>{m.online_upload_title()}</Button></div>
  </section>;
}

function SummaryValues({ summary, coverage }: { summary: DriverSummary; coverage: ProfileCoverage }) {
  const metrics = summary.metrics;
  const number = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 });
  const durationAvailable = coverage.sessionDuration !== "unavailable";
  return <>
    <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
      <div><dt className="text-app-text-muted">{m.recap_laps()}</dt><dd className="font-medium">{number.format(metrics.laps)}</dd></div>
      <div><dt className="text-app-text-muted">{m.online_summary_valid_laps()}</dt><dd className="font-medium">{number.format(metrics.validLaps)}</dd></div>
      <div><dt className="text-app-text-muted">{m.online_summary_driving_time()}</dt><dd className="font-medium">{m.online_summary_seconds({ seconds: number.format(metrics.drivenSeconds) })}</dd></div>
      <div><dt className="text-app-text-muted">{m.recap_distance()}</dt><dd>{metrics.distanceMeters == null || coverage.distance === "unavailable" ? m.online_queue_unavailable() : m.online_summary_meters({ meters: number.format(metrics.distanceMeters) })}</dd></div>
    </dl>
    <p className="mt-3 text-app-text-muted">{coverage.identity === "partial" || coverage.driverAttribution === "partial" || coverage.distance === "partial" || coverage.sessionDuration === "partial" ? m.online_summary_partial() : m.online_summary_coverage_note()}</p>
    <details className="mt-3"><summary className="cursor-pointer">{m.online_summary_session_duration()}</summary>
      {!durationAvailable ? <p className="mt-2">{m.online_summary_duration_unavailable()}</p> : <><p className="mt-2 text-app-text-muted">{coverage.sessionDuration === "partial" ? m.online_summary_duration_partial() : m.online_summary_duration_note()}</p><dl className="mt-2 grid grid-cols-2 gap-2">{(["practice", "qualifying", "race", "unknown"] as const).map((kind) => <div key={kind}><dt>{kind === "practice" ? m.online_session_practice() : kind === "qualifying" ? m.online_session_qualifying() : kind === "race" ? m.online_session_race() : m.online_session_unknown()}</dt><dd>{m.online_summary_seconds({ seconds: number.format(metrics.sessionTypeSeconds[kind]) })}</dd></div>)}</dl></>}
    </details>
    {summary.games.length > 0 && <details className="mt-3"><summary className="cursor-pointer">{m.online_summary_favourites()}</summary><ul className="mt-2 space-y-2">{summary.games.map((game) => <li key={game.gameId} className="break-words"><span className="font-medium">{game.gameId}</span><dl className="mt-1 grid gap-1 sm:grid-cols-2"><div><dt className="text-app-text-muted">{m.online_summary_favourite_car()}</dt><dd>{game.favoriteCar?.name ?? m.online_queue_unknown()}</dd></div><div><dt className="text-app-text-muted">{m.online_summary_favourite_track()}</dt><dd>{game.favoriteTrack?.name ?? m.online_queue_unknown()}</dd></div></dl></li>)}</ul></details>}
  </>;
}
