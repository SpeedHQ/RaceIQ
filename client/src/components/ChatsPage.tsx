import { getGame } from "@shared/games/registry";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, MessageSquare, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { m } from "@/paraglide/messages";
import { useGameId } from "../stores/game";

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
      await fetch(`/api/chats/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      setRows((prev) => prev.filter((r) => r.threadId !== threadId));
    } catch {
      /* ignore */
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
            lapB: b.id,
            carA: undefined,
            carB: undefined,
            ai: 1,
          } as never,
        });
      } else if (row.type === "tune" && row.tune) {
        navigate({
          to: `${prefix}/tuning/$tuningSessionId` as never,
          params: { tuningSessionId: String(row.tune.id) } as never,
        });
      }
    },
    [gameId, navigate],
  );

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-hidden">
      <div className="flex items-center gap-2 shrink-0">
        <MessageSquare className="size-4 text-app-text-secondary" />
        <h1 className="text-sm font-semibold text-app-text uppercase tracking-wider">{m.chats_title()}</h1>
        <span className="text-[10px] text-app-text-muted">({rows.length})</span>
      </div>

      {loading && <div className="text-app-text-muted text-sm">{m.common_loading()}</div>}
      {error && <div className="text-red-400 text-sm">{error}</div>}

      {!loading && !error && rows.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-app-text-dim">
          <Sparkles className="size-6 text-app-text-dim" />
          <p className="text-sm">{m.chats_empty_title()}</p>
          <p className="text-[11px] text-app-text-muted">{m.chats_empty_desc()}</p>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-app-border bg-app-surface">
          <table className="w-full min-w-max md:min-w-0 text-[12px]">
            <thead className="sticky top-0 bg-app-surface-alt/80 backdrop-blur z-10 border-b border-app-border">
              <tr className="text-left text-[10px] uppercase tracking-wider text-app-text-muted">
                <th className="px-3 py-2 font-semibold">{m.label_type()}</th>
                <th className="px-3 py-2 font-semibold">{m.label_track()}</th>
                <th className="px-3 py-2 font-semibold">{m.chats_col_cars()}</th>
                <th className="px-3 py-2 font-semibold">{m.chats_col_laps()}</th>
                <th className="px-3 py-2 font-semibold">{m.chats_col_updated()}</th>
                <th className="px-3 py-2 font-semibold text-right">{m.label_actions()}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.threadId} className="border-b border-app-border/40 hover:bg-app-surface-alt/40 transition-colors">
                  <td className="px-3 py-2">
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        row.type === "compare"
                          ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
                          : row.type === "tune"
                            ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                            : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                      }`}
                    >
                      {row.type === "tune" ? "setup" : row.type}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-app-text">{row.trackName || "—"}</td>
                  <td className="px-3 py-2 text-app-text-secondary">
                    {row.type === "tune" && row.tune ? (
                      <span className="truncate max-w-[180px] block">{row.tune.carName || "—"}</span>
                    ) : (
                      row.laps.map((l, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          {row.type === "compare" && <span className={`w-1.5 h-1.5 rounded-full ${i === 0 ? "bg-orange-500" : "bg-blue-500"}`} />}
                          <span className="truncate max-w-[180px]">{l.carName}</span>
                        </div>
                      ))
                    )}
                  </td>
                  <td className="px-3 py-2 text-app-text-secondary font-mono text-[11px]">
                    {row.type === "tune" && row.tune ? (
                      <span className="truncate max-w-[220px] block">#{row.tune.seq} — {row.tune.name}</span>
                    ) : (
                      row.laps.map((l, i) => (
                        <div key={i}>
                          {m.chats_lap_number()} {l.lapNumber} — {formatLapTime(l.lapTime)}
                          {!l.isValid && <span className="text-red-400 ml-1">(inv)</span>}
                        </div>
                      ))
                    )}
                  </td>
                  <td className="px-3 py-2 text-app-text-muted">{formatRelative(row.updatedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleOpen(row)}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded hover:bg-app-surface-alt text-app-text-secondary hover:text-app-text"
                        title={m.chats_open()}
                      >
                        <ExternalLink className="size-3" /> {m.chats_open()}
                      </button>
                      <button
                        onClick={() => handleDelete(row.threadId)}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded hover:bg-red-500/15 text-app-text-muted hover:text-red-400"
                        title={m.chats_delete_title()}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
