import { useEffect, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { AlertTriangle, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { m } from "@/paraglide/messages";
import { refreshClassificationMigration, retryClassificationRecording } from "@/lib/classification-migration";
import { classificationMigrationActions, useClassificationMigration } from "@/stores/classification-migration";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";
import { useSessions } from "@/hooks/session-queries";
import { sessionCarName, sessionTrackName } from "@/components/sessions/helpers";
import type { SessionMeta } from "@raceiq/shared/racing/sessions/types";
import type { SessionNames } from "@/components/sessions/types";
import type { ClassificationMigrationRecording } from "@raceiq/shared/racing/laps/classification-migration";

function reasonLabel(reason: string | null) {
  switch (reason) {
    case "active_capture": return m.classification_migration_reason_active();
    case "maintenance_busy": return m.classification_migration_reason_busy();
    case "source_changed": return m.classification_migration_reason_changed();
    case "missing_source": return m.classification_migration_reason_missing();
    case "insufficient_evidence": return m.classification_migration_reason_evidence();
    case "corrupt_source": return m.classification_migration_reason_corrupt();
    case "ambiguous_match": return m.classification_migration_reason_ambiguous();
    default: return m.classification_migration_reason_failed();
  }
}

function useRecordingSessionLabels(recordings: ClassificationMigrationRecording[]) {
  const { data: allSessions = [] } = useSessions({ allGames: true });
  const requestedIds = useMemo(() => new Set(recordings.flatMap((recording) => recording.sessionIds)), [recordings]);
  const sourceSessions = useMemo(() => allSessions.filter((session) => requestedIds.has(session.id)), [allSessions, requestedIds]);
  const gameGroups = useMemo(() => {
    const groups = new Map<NonNullable<SessionMeta["gameId"]>, { gameId: NonNullable<SessionMeta["gameId"]>; tracks: Set<string>; cars: Set<string> }>();
    for (const session of sourceSessions) {
      if (!session.gameId) continue;
      const group = groups.get(session.gameId) ?? { gameId: session.gameId, tracks: new Set<string>(), cars: new Set<string>() };
      if (session.trackId) group.tracks.add(session.trackId);
      if (session.carId) group.cars.add(session.carId);
      groups.set(session.gameId, group);
    }
    return [...groups.values()].map((group) => ({ gameId: group.gameId, tracks: [...group.tracks].sort(), cars: [...group.cars].sort() }));
  }, [sourceSessions]);
  const nameQueries = useQueries({
    queries: gameGroups.map((group) => ({
      queryKey: ["resolve-names", group.gameId, JSON.stringify(group.tracks), JSON.stringify(group.cars)],
      queryFn: async () => rpcJson<{ trackNames: Record<string, string>; carNames: Record<string, string> }>(await client.api["resolve-names"].$get({
        query: { gameId: group.gameId, tracks: group.tracks.length ? JSON.stringify(group.tracks) : undefined, cars: group.cars.length ? JSON.stringify(group.cars) : undefined },
      })),
      enabled: group.tracks.length > 0 || group.cars.length > 0,
    })),
  });
  return useMemo(() => {
    const labels = new Map<number, string>();
    for (const session of sourceSessions) {
      const index = gameGroups.findIndex((group) => group.gameId === session.gameId);
      const resolved = index < 0 ? undefined : nameQueries[index]?.data;
      const names: SessionNames = { trackNames: resolved?.trackNames ?? {}, carNames: resolved?.carNames ?? {} };
      const detail = [sessionTrackName(session, names), sessionCarName(session, names)].filter(Boolean).join(" · ");
      labels.set(session.id, detail ? `${detail} (${m.classification_migration_session_fallback({ id: session.id })})` : m.classification_migration_session_fallback({ id: session.id }));
    }
    return labels;
  }, [gameGroups, nameQueries, sourceSessions]);
}

export function ClassificationMigrationDock({ suppressed = false }: { suppressed?: boolean }) {
  const status = useClassificationMigration((state) => state.status);
  const dismissed = useClassificationMigration((state) => state.dismissedRevision);
  const running = status?.status === "running";
  const terminal = status?.status === "complete" || status?.status === "attention";
  if (suppressed || !status || status.status === "idle" || (!running && terminal && dismissed === status.revision)) return null;
  return <Dialog open modal={false} onOpenChange={(open) => { if (!open && terminal) classificationMigrationActions.dismiss(status.revision); }}>
    <DialogContent size="sm" layout="scrollable" showCloseButton={false} overlayClassName="hidden" className="top-auto left-auto right-4 bottom-20 w-[min(24rem,calc(100%-2rem))] max-h-[min(70dvh,32rem)] translate-x-0 translate-y-0 gap-3 rounded-lg p-4" aria-label={m.classification_migration_title()}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {status.status === "attention" ? <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 text-status-warning" /> : status.status === "complete" ? <Check aria-hidden="true" className="mt-0.5 size-4 text-status-success" /> : null}
          <div><DialogTitle className="text-sm font-semibold">{m.classification_migration_title()}</DialogTitle><DialogDescription role="status" className="mt-1 text-xs text-app-text-muted">{running ? m.classification_migration_historical_caveat() : status.status === "complete" ? m.classification_migration_complete() : m.classification_migration_attention()}</DialogDescription></div>
        </div>
        {terminal && <Button type="button" variant="app-ghost" size="icon-sm" aria-label={m.common_close()} onClick={() => classificationMigrationActions.dismiss(status.revision)}><X aria-hidden="true" className="size-4" /></Button>}
      </div>
      <p className="text-xs text-app-text-secondary">{m.classification_migration_counts({ completed: status.completed, pending: status.pending + status.running, limited: status.limited, failed: status.failed })}</p>
    </DialogContent>
  </Dialog>;
}

export function ClassificationMigrationMaintenance() {
  const status = useClassificationMigration((state) => state.status);
  const recordings = useClassificationMigration((state) => state.recordings);
  const error = useClassificationMigration((state) => state.error);
  const retrying = useClassificationMigration((state) => state.retrying);
  const sessionLabels = useRecordingSessionLabels(recordings);
  useEffect(() => { void refreshClassificationMigration(); }, []);
  return <section className="space-y-3 rounded-lg border border-app-border bg-app-surface-alt/50 p-4" aria-labelledby="classification-migration-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="classification-migration-heading" className="text-sm font-semibold text-app-text">{m.classification_migration_title()}</h3><Button type="button" variant="app-outline" size="app-sm" onClick={() => void refreshClassificationMigration()}>{m.classification_migration_refresh()}</Button></div>
    {error && <p role="alert" className="text-sm text-status-danger">{error === "retry" ? m.classification_migration_retry_error() : m.classification_migration_connection_error()}</p>}
    {status && <><p role="status" className="text-xs text-app-text-muted">{status.status === "running" ? m.classification_migration_historical_caveat() : status.status === "attention" ? m.classification_migration_attention() : status.status === "complete" ? m.classification_migration_complete() : m.classification_migration_idle()}</p><ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-app-text-secondary"><li>{m.classification_migration_classified({ count: status.completed })}</li><li>{m.classification_migration_pending({ count: status.pending + status.running })}</li><li>{m.classification_migration_limited({ count: status.limited })}</li><li>{m.classification_migration_failed({ count: status.failed })}</li></ul>{status.aggregatesPending && <p className="text-xs text-app-text-muted">{m.classification_migration_aggregates_pending()}</p>}</>}
    {recordings.length > 0 && <ul className="max-h-72 space-y-2 overflow-y-auto border-t border-app-border pt-3">{recordings.map((recording) => {
      const sourceName = recording.sessionIds.length
        ? recording.sessionIds.map((sessionId) => sessionLabels.get(sessionId) ?? m.classification_migration_session_fallback({ id: sessionId })).join(" · ")
        : m.classification_migration_no_session_details();
      return <li key={recording.recordingId} data-recording-id={recording.recordingId} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="min-w-0"><span className="block break-words text-app-text-secondary">{sourceName}</span><span className="text-app-text-muted">{recording.reason ? reasonLabel(recording.reason) : recording.state === "running" ? m.classification_migration_historical_caveat() : m.classification_migration_pending({ count: 1 })}</span></span>{recording.retryable && <Button type="button" variant="app-outline" size="app-sm" aria-label={`${m.classification_migration_retry()} ${sourceName}`} disabled={retrying.includes(recording.recordingId)} onClick={() => void retryClassificationRecording(recording.recordingId)}>{retrying.includes(recording.recordingId) ? m.common_loading() : m.classification_migration_retry()}</Button>}</li>;
    })}</ul>}
  </section>;
}
