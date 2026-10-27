import { getGameRoute, useGameId } from "../stores/game";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MessageSquare, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import type { ProcessingMetadata } from "@raceiq/shared/racing/sessions/types";
import { usePendingMetadataRefetchInterval } from "@/hooks/session-queries";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Button } from "./ui/button";
import { ProcessingStatus } from "./ProcessingStatus";

import { parseUtcTimestamp } from "@raceiq/frontend-pure/utc-date";
import { authenticatedFetch } from "@/lib/rpc";
interface LapSummary {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carName: string;
  trackName: string;
  carId: string;
  trackId: string;
  gameId: string;
  processing: ProcessingMetadata;
}
interface TuneSummary {
  id: number;
  seq: number;
  name: string;
  carName: string;
  gameId: string;
}

interface ChatRow {
  threadId: string;
  type: "analyse" | "compare" | "tune";
  laps: LapSummary[];
  tune?: TuneSummary;
  trackName: string;
  createdAt: string;
  updatedAt: string;
}
function formatLapTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, "0")}` : s.toFixed(3);
}

function formatRelative(iso: string): string {
  const ts = parseUtcTimestamp(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ${m.chats_seconds_ago()}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${m.home_minutes_ago()}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${m.home_hours_ago()}`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ${m.home_days_ago()}`;
  return parseUtcTimestamp(iso).toLocaleDateString(getLocale());
}
export function ChatsPage() {
  const gameId = useGameId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<{ gameId: string | null; message: string } | null>(null);
  const pendingLapRefetchInterval = usePendingMetadataRefetchInterval<LapSummary>();
  const chatsQueryKey = ["chats", gameId] as const;
  const chatsQuery = useQuery({
    queryKey: chatsQueryKey,
    queryFn: async ({ signal }) => {
      if (!gameId) return [];
      const res = await fetch(`/api/chats?gameId=${encodeURIComponent(gameId)}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { chats: ChatRow[] };
      return data.chats ?? [];
    },
    enabled: !!gameId,
    refetchInterval: (query) => pendingLapRefetchInterval({ state: { data: query.state.data?.flatMap((row) => row.laps) } }),
    refetchIntervalInBackground: false,
  });
  const error = (actionError?.gameId === (gameId ?? null) ? actionError.message : null) ?? (chatsQuery.isError ? chatsQuery.error instanceof Error ? chatsQuery.error.message : m.chats_load_failed() : null);
  useEffect(() => { setActionError(null); }, [gameId]);
  const refreshProcessing = useCallback(() => {
    setActionError(null);
    void chatsQuery.refetch();
  }, [chatsQuery.refetch]);


  const handleDelete = useCallback(async (threadId: string) => {
    if (!confirm(m.chats_delete_confirm())) return;
    try {
      await queryClient.cancelQueries({ queryKey: chatsQueryKey });
      const response = await authenticatedFetch(`/api/chats/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await queryClient.cancelQueries({ queryKey: chatsQueryKey });
      queryClient.setQueryData<ChatRow[]>(chatsQueryKey, (previous) => previous?.filter((row) => row.threadId !== threadId));
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: chatsQueryKey });
    } catch (err: unknown) {
      setActionError({ gameId: gameId ?? null, message: err instanceof Error ? err.message : m.chats_load_failed() });
      void queryClient.invalidateQueries({ queryKey: chatsQueryKey });
    }
  }, [chatsQueryKey, gameId, queryClient]);
  const canOpenRow = useCallback((row: ChatRow) => {
    if (row.type === "tune") return row.tune != null;
    const requiredLaps = row.type === "analyse" ? row.laps.slice(0, 1) : row.type === "compare" && row.laps.length === 2 ? row.laps : [];
    if (requiredLaps.length !== (row.type === "analyse" ? 1 : 2) || (row.type === "analyse" && requiredLaps[0]?.sessionId == null)) return false;
    return requiredLaps.every((lap) => lap.processing?.state === "ready");
  }, []);

  const handleOpen = useCallback(
    (row: ChatRow) => {
      if (!canOpenRow(row)) return;
      const rowGameId = row.laps[0]?.gameId ?? row.tune?.gameId;
      const routePrefix = rowGameId ? getGameRoute(rowGameId) : undefined;
      if (!routePrefix) return;
      if (row.type === "analyse" && row.laps[0]) {
        const lap = row.laps[0];
        if (lap.sessionId == null) return;
        navigate({
          to: `${routePrefix}/sessions/${lap.sessionId}/replay/${lap.id}` as never,
          search: { ai: 1 } as never,
        });
      } else if (row.type === "compare" && row.laps.length === 2) {
        const [a, b] = row.laps;
        navigate({
          to: `${routePrefix}/compare` as never,
          search: {
            track: a.trackId ?? b.trackId,
            carA: a.carId,
            carB: b.carId,
            lapA: a.id,
            lapB: b.id,
            ai: 1,
          } as never,
        });
      } else if (row.type === "tune" && row.tune) {
        navigate({
          to: `${routePrefix}/experiments/$experimentId` as never,
          params: { experimentId: String(row.tune.id) } as never,
        });
      }
    },
    [canOpenRow, navigate],
  );
  const rows: ChatRow[] = chatsQuery.data ?? [];
  const loading = chatsQuery.isLoading;
  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-hidden">
      <div className="flex items-center gap-2 shrink-0">
        <MessageSquare className="size-5 text-app-text-secondary" />
        <h1 className="text-app-title font-semibold text-app-text">{m.chats_title()}</h1>
        <span className="text-app-label text-app-text-muted">({rows.length})</span>
      </div>
      {loading && <div className="text-app-text-muted text-app-subtext">{m.common_loading()}</div>}
      {error && <div className="text-status-danger text-app-subtext">{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-app-text-dim">
          <Sparkles className="size-6 text-app-text-dim" />
          <p className="text-app-body font-medium">{m.chats_empty_title()}</p>
          <p className="text-app-subtext text-app-text-muted">{m.chats_empty_desc()}</p>
        </div>
      )}
      {!loading && rows.length > 0 && (
        <div className="flex-1 min-h-0 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">{m.label_type()}</TableHead>
                <TableHead className="whitespace-nowrap">{m.label_track()}</TableHead>
                <TableHead className="whitespace-nowrap">{m.chats_col_cars()}</TableHead>
                <TableHead className="whitespace-nowrap">{m.chats_col_laps()}</TableHead>
                <TableHead className="whitespace-nowrap">{m.chats_col_updated()}</TableHead>
                <TableHead className="text-right whitespace-nowrap">{m.label_actions()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const canOpen = canOpenRow(row);
                const rowLapProcessing = row.type === "tune" ? [] : row.laps.map((lap) => lap.processing);
                const rowProcessingLoading = row.type !== "tune" && rowLapProcessing.some((processing) => processing == null);
                const rowProcessingPending = rowProcessingLoading || rowLapProcessing.some((processing) => processing?.state === "queued" || processing?.state === "processing");
                return (
                <TableRow key={row.threadId} data-testid={`chat-row-${row.threadId}`} aria-busy={rowProcessingPending} aria-disabled={!canOpen}>
                  <TableCell>
                    <span className={`text-app-caption font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${row.type === "compare" ? "bg-status-info/15 text-status-info border border-status-info/30" : row.type === "tune" ? "bg-status-success/15 text-status-success border border-status-success/30" : "bg-status-warning/15 text-status-warning border border-status-warning/30"}`}>
                      {row.type === "tune" ? "setup" : row.type}
                    </span>
                  </TableCell>
                  <TableCell className="text-app-text-primary whitespace-nowrap">{row.trackName || "—"}</TableCell>
                  <TableCell>
                    {row.type === "tune" && row.tune ? <span className="block truncate max-w-[180px]">{row.tune.carName || "—"}</span> : row.laps.map((l, lapIndex) => (
                      <div key={`${row.threadId}:${l.id}`} className="flex items-center gap-1.5">
                        {row.type === "compare" && <span className={`w-1.5 h-1.5 rounded-full ${lapIndex === 0 ? "bg-(--comparison-lap-a)" : "bg-(--comparison-lap-b)"}`} />}
                        <span className="truncate max-w-[180px]">{l.carName}</span>
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {row.type === "tune" && row.tune ? <span className="block truncate max-w-[220px]">#{row.tune.seq} — {row.tune.name}</span> : row.laps.map((l) => {
                      const processing = l.processing;
                      const processingLoadingForLap = processing == null;
                      return (
                        <div key={`${row.threadId}:${l.id}-lap-${l.lapNumber}`}>
                          {m.chats_lap_number()} {l.lapNumber} — {formatLapTime(l.lapTime)}
                          {!l.isValid && <span className="text-status-danger ml-1">(inv)</span>}
                          <ProcessingStatus processing={processing} loading={processingLoadingForLap} onRefresh={refreshProcessing} className="mt-1" />
                        </div>
                      );
                    })}
                  </TableCell>
                  <TableCell className="text-app-text-muted whitespace-nowrap">{formatRelative(row.updatedAt)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button disabled={!canOpen} aria-busy={rowProcessingPending} onClick={() => handleOpen(row)} className="inline-flex items-center gap-1 text-app-compact px-2 py-1 rounded hover:bg-app-surface-hover text-app-text-secondary hover:text-app-text" title={m.chats_open()}>
                        <ExternalLink className="size-3" /> {m.chats_open()}
                      </Button>
                      <Button onClick={() => void handleDelete(row.threadId)} className="inline-flex items-center gap-1 text-app-compact px-2 py-1 rounded hover:bg-status-danger/15 text-app-text-muted hover:text-status-danger" title={m.chats_delete_title()}>
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
