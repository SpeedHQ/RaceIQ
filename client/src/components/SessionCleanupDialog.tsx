import type { CleanupAgeDays, SessionCleanupGameSummary, SessionCleanupPreview, SessionCleanupRequest, SessionCleanupResult } from "@shared/racing/sessions/cleanup";
import { CalendarClock } from "lucide-react";
import { useEffect, useState } from "react";
import { formatLapTime } from "@/components/LiveTelemetry";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes } from "@/lib/format-bytes";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

type Props = {
  request: SessionCleanupRequest | null;
  onClose: () => void;
  onCompleted: (result: SessionCleanupResult) => void;
};

const CLEANUP_AGE_OPTIONS: CleanupAgeDays[] = [7, 30, 90, 180, 365];

function CleanupGameTables({ game }: { game: SessionCleanupGameSummary }) {
  const gameLaps = game.sessions.flatMap((session) => session.laps.map((lap) => ({ ...lap, cleanupSessionId: session.id })));

  return (
    <TabsContent value={game.gameId} className="space-y-4 pt-3">
      <div className="flex flex-wrap gap-2">
        <div className="min-w-32 rounded-md bg-app-surface-alt/60 px-3 py-2">
          <div className="text-app-caption font-medium uppercase tracking-wider text-app-text-dim">{m.label_sessions()}</div>
          <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-app-text">{game.sessionCount}</div>
        </div>
        <div className="min-w-32 rounded-md bg-app-surface-alt/60 px-3 py-2">
          <div className="text-app-caption font-medium uppercase tracking-wider text-app-text-dim">{m.sessions_cleanup_reclaimable()}</div>
          <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-app-text">{formatBytes(game.reclaimableBytes)}</div>
        </div>
      </div>
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-app-text">{m.label_sessions()}</h3>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-app-border">
          <Table density="compact" fit variant="embedded">
            <THead>
              <TH nowrap>ID</TH>
              <TH nowrap>{m.sessions_col_date()}</TH>
              <TH>{m.label_track()}</TH>
              <TH>{m.label_car()}</TH>
              <TH align="end">{m.label_laps()}</TH>
            </THead>
            <TBody>
              {game.sessions.map((session) => (
                <TRow key={session.id} variant="static">
                  <TD numeric tone="dim">
                    #{session.id}
                  </TD>
                  <TD nowrap tone="primary">
                    {new Date(session.createdAt).toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" })}
                  </TD>
                  <TD tone="primary">{session.trackName}</TD>
                  <TD>{session.carName}</TD>
                  <TD align="end" numeric>
                    {session.laps.length}
                  </TD>
                </TRow>
              ))}
            </TBody>
          </Table>
        </div>
      </section>
      {gameLaps.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-app-text">{m.label_laps()}</h3>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-app-border">
            <Table density="compact" fit variant="embedded">
              <THead>
                <TH nowrap>{m.label_sessions()}</TH>
                <TH align="end">{m.label_lap()}</TH>
                <TH align="end">{m.label_time()}</TH>
                <TH>{m.sessions_cleanup_status()}</TH>
              </THead>
              <TBody>
                {gameLaps.map((lap) => (
                  <TRow key={lap.id} variant="static">
                    <TD numeric tone="dim">
                      #{lap.cleanupSessionId}
                    </TD>
                    <TD align="end" numeric tone="primary">
                      {lap.lapNumber}
                    </TD>
                    <TD align="end" numeric>
                      {formatLapTime(lap.lapTime)}
                    </TD>
                    <TD tone={lap.isValid ? "success" : "danger"}>{lap.isValid ? m.sessions_cleanup_valid() : m.sessions_cleanup_invalid()}</TD>
                  </TRow>
                ))}
              </TBody>
            </Table>
          </div>
        </section>
      )}
    </TabsContent>
  );
}

export function SessionCleanupDialog({ request, onClose, onCompleted }: Props) {
  const [preview, setPreview] = useState<SessionCleanupPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionCleanupResult | null>(null);
  const [olderThanDays, setOlderThanDays] = useState<CleanupAgeDays>(30);
  const cleanupRequest = request?.mode === "older-than" ? { ...request, olderThanDays } : request;

  useEffect(() => {
    if (!cleanupRequest) {
      setPreview(null);
      setError(null);
      setResult(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setResult(null);
    setError(null);
    setLoading(true);
    void fetch("/api/storage/session-cleanup/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cleanupRequest) })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as SessionCleanupPreview | { error?: string } | null;
        if (!response.ok) throw new Error((data && "error" in data ? data.error : undefined) ?? `${response.status} ${response.statusText}`);
        if (!cancelled) setPreview(data as SessionCleanupPreview);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request, olderThanDays]);

  const execute = async () => {
    if (!cleanupRequest || !preview || preview.candidateSessionIds.length === 0 || executing) return;
    setExecuting(true);
    setError(null);
    try {
      const response = await fetch("/api/storage/session-cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cleanupRequest) });
      const data = (await response.json().catch(() => null)) as SessionCleanupResult | { error?: string } | null;
      if (response.status === 409) throw new Error(m.sessions_cleanup_active_recording());
      if (!response.ok) throw new Error((data && "error" in data ? data.error : undefined) ?? `${response.status} ${response.statusText}`);
      const cleanupResult = data as SessionCleanupResult;
      setResult(cleanupResult);
      onCompleted(cleanupResult);
      if (cleanupResult.failed.length === 0) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExecuting(false);
    }
  };

  if (!request) return null;
  const failed = result?.failed ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && !executing && onClose()}>
      <DialogContent size="wide" showCloseButton={!executing} overlayClassName="bg-app-bg/60">
        <DialogHeader>
          <DialogTitle className="text-xs font-medium text-app-text/90 uppercase tracking-wider">{m.sessions_cleanup_title()}</DialogTitle>
        </DialogHeader>
        {request.mode === "older-than" && (
          <>
            <p className="text-sm text-app-text-muted">{m.sessions_cleanup_explanation()}</p>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-app-border bg-app-surface-alt/50 px-3 py-2.5">
              <Label htmlFor="session-cleanup-age" className="flex items-center gap-2 text-sm text-app-text-muted">
                <CalendarClock className="size-4 text-app-text-dim" aria-hidden="true" />
                {m.sessions_cleanup_age_label()}
              </Label>
              <select
                id="session-cleanup-age"
                value={olderThanDays}
                disabled={executing}
                onChange={(event) => setOlderThanDays(Number(event.target.value) as CleanupAgeDays)}
                className="h-8 min-w-32 rounded-md border border-app-border-input bg-app-surface px-2.5 text-xs font-medium text-app-text outline-none transition-colors hover:border-app-border-hover focus:border-app-accent focus:ring-2 focus:ring-app-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {CLEANUP_AGE_OPTIONS.map((days) => (
                  <option key={days} value={days}>
                    {m.sessions_cleanup_age_option({ days })}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        {loading && <p className="text-sm text-app-text-muted">{m.common_loading()}</p>}
        {error && (
          <p role="alert" className="rounded border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger">
            {error}
          </p>
        )}
        {preview && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-app-text-muted">{m.sessions_cleanup_eligible()}</dt>
              <dd className="text-app-text font-medium">{preview.candidateSessionIds.length}</dd>
              <dt className="text-app-text-muted">{m.sessions_cleanup_capture_groups()}</dt>
              <dd className="text-app-text font-medium">{preview.fileCount}</dd>
              <dt className="text-app-text-muted">{m.sessions_cleanup_reclaimable()}</dt>
              <dd className="text-app-text font-medium">{formatBytes(preview.reclaimableBytes)}</dd>
              <dt className="text-app-text-muted">{m.sessions_cleanup_protected()}</dt>
              <dd className="text-app-text">{preview.protectedSessionIds.length}</dd>
              <dt className="text-app-text-muted">{m.sessions_cleanup_unavailable()}</dt>
              <dd className="text-app-text">{preview.unavailableSessionIds.length}</dd>
            </dl>
            {preview.games.length > 0 && (
              <Tabs key={preview.games.map((game) => game.gameId).join(":")} defaultValue={preview.games[0]?.gameId}>
                <TabsList variant="underline" aria-label={m.sessions_cleanup_games()}>
                  {preview.games.map((game) => (
                    <TabsTrigger key={game.gameId} value={game.gameId} variant="underline">
                      {game.gameName}
                      <span className="ml-1.5 rounded bg-app-surface-alt px-1.5 py-0.5 font-mono text-app-caption tabular-nums text-app-text-muted">{game.sessionCount}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
                {preview.games.map((game) => (
                  <CleanupGameTables key={game.gameId} game={game} />
                ))}
              </Tabs>
            )}
          </>
        )}
        {failed.length > 0 && (
          <div role="alert" className="rounded border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
            <p className="font-medium">{m.sessions_cleanup_partial_failure({ count: failed.length })}</p>
            <ul className="mt-1 list-disc pl-5">
              {failed.map((item) => (
                <li key={item.sessionIds.join(",")}>{item.message}</li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter className="border-0 bg-transparent p-0 -mx-0 -mb-0">
          <Button variant="app-ghost" size="app-sm" disabled={executing} onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button variant="app-danger" size="app-sm" disabled={loading || executing || !preview || preview.candidateSessionIds.length === 0} onClick={() => void execute()}>
            {executing ? m.common_loading() : m.sessions_cleanup_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
