import { getGame } from "@shared/games/registry";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, MessageSquare, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { m } from "@/paraglide/messages";
import { useGameId } from "../stores/game";
import { Table, TBody, TD, TH, THead, TRow } from "./ui/AppTable";
import { Button } from "./ui/button";

interface LapSummary {
  id: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carName: string;
  trackName: string;
  gameId: string;
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
  const ts = new Date(iso).getTime();
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
  return new Date(iso).toLocaleDateString();
}

export function ChatsPage() {
  const gameId = useGameId();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!gameId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/chats?gameId=${encodeURIComponent(gameId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { chats: ChatRow[] };
      setRows(data.chats ?? []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : m.chats_load_failed());
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = useCallback(async (threadId: string) => {
    if (!confirm(m.chats_delete_confirm())) return;
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setRows((prev) => prev.filter((r) => r.threadId !== threadId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : m.chats_load_failed());
    }
  }, []);

  const handleOpen = useCallback(
    (row: ChatRow) => {
      if (!gameId) return;
      const game = getGame(gameId);
      const prefix = `/${game.routePrefix}`;
      if (row.type === "analyse" && row.laps[0]) {
        const lap = row.laps[0];
        navigate({
          to: `${prefix}/analyse` as never,
          search: { lap: lap.id, ai: 1 } as never,
        });
      } else if (row.type === "compare" && row.laps.length === 2) {
        const [a, b] = row.laps;
        navigate({
          to: `${prefix}/compare` as never,
          search: {
            lapA: a.id,
            laps: String(b.id),
            carA: undefined,
            ai: 1,
          } as never,
        });
      } else if (row.type === "tune" && row.tune) {
        navigate({
          to: `${prefix}/experiments/$experimentId` as never,
          params: { experimentId: String(row.tune.id) } as never,
        });
      }
    },
    [gameId, navigate],
  );

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
          <Table fit>
            <THead>
              <TH nowrap>{m.label_type()}</TH>
              <TH nowrap>{m.label_track()}</TH>
              <TH nowrap>{m.chats_col_cars()}</TH>
              <TH nowrap>{m.chats_col_laps()}</TH>
              <TH nowrap>{m.chats_col_updated()}</TH>
              <TH align="end" nowrap>
                {m.label_actions()}
              </TH>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TRow key={row.threadId} data-testid={`chat-row-${row.threadId}`}>
                  <TD>
                    <span
                      className={`text-app-caption font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        row.type === "compare"
                          ? "bg-status-info/15 text-status-info border border-status-info/30"
                          : row.type === "tune"
                            ? "bg-status-success/15 text-status-success border border-status-success/30"
                            : "bg-status-warning/15 text-status-warning border border-status-warning/30"
                      }`}
                    >
                      {row.type === "tune" ? "setup" : row.type}
                    </span>
                  </TD>
                  <TD tone="primary" nowrap truncate="wide">
                    {row.trackName || "—"}
                  </TD>
                  <TD>
                    {row.type === "tune" && row.tune ? (
                      <span className="block truncate max-w-[180px]">{row.tune.carName || "—"}</span>
                    ) : (
                      row.laps.map((l, lapIndex) => (
                        <div key={`${row.threadId}:${l.id}`} className="flex items-center gap-1.5">
                          {row.type === "compare" && <span className={`w-1.5 h-1.5 rounded-full ${lapIndex === 0 ? "bg-(--comparison-lap-a)" : "bg-(--comparison-lap-b)"}`} />}
                          <span className="truncate max-w-[180px]">{l.carName}</span>
                        </div>
                      ))
                    )}
                  </TD>
                  <TD numeric>
                    {row.type === "tune" && row.tune ? (
                      <span className="block truncate max-w-[220px]">
                        #{row.tune.seq} — {row.tune.name}
                      </span>
                    ) : (
                      row.laps.map((l) => (
                        <div key={`${row.threadId}:${l.id}-lap-${l.lapNumber}`}>
                          {m.chats_lap_number()} {l.lapNumber} — {formatLapTime(l.lapTime)}
                          {!l.isValid && <span className="text-status-danger ml-1">(inv)</span>}
                        </div>
                      ))
                    )}
                  </TD>
                  <TD tone="muted" nowrap>
                    {formatRelative(row.updatedAt)}
                  </TD>
                  <TD align="end">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        onClick={() => handleOpen(row)}
                        className="inline-flex items-center gap-1 text-app-compact px-2 py-1 rounded hover:bg-app-surface-hover text-app-text-secondary hover:text-app-text"
                        title={m.chats_open()}
                      >
                        <ExternalLink className="size-3" /> {m.chats_open()}
                      </Button>
                      <Button
                        onClick={() => handleDelete(row.threadId)}
                        className="inline-flex items-center gap-1 text-app-compact px-2 py-1 rounded hover:bg-status-danger/15 text-app-text-muted hover:text-status-danger"
                        title={m.chats_delete_title()}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </TD>
                </TRow>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
