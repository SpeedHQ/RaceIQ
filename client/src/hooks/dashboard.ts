import type { DashboardResponse } from "@raceiq/shared/racing/sessions/dashboard";
import type { GameId } from "@raceiq/shared/games/ids";
import type { SessionRecap } from "@raceiq/shared/racing/sessions/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { queryClient } from "@/lib/queryClient";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";
import { useGameId } from "@/stores/game";
import type { PeriodKey } from "@/components/home/types";
const DASHBOARD_REFRESH_EVENT = "raceiq:dashboard-refresh";
export const dashboardQueryKeys = {
  all: ["dashboard"] as const,
  data: (gameId: GameId | null, from: string, to: string, timeZone: string) => ["dashboard", gameId, from, to, timeZone] as const,
  recap: ["dashboard-recap"] as const,
  recapById: (sessionId: number | null, gameId: GameId | null) => ["dashboard-recap", sessionId, gameId] as const,
};

export function invalidateDashboardQueries() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DASHBOARD_REFRESH_EVENT));
  void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.all, refetchType: "none" });
  void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.recap });
}

const DAY_MS = 86_400_000;

function periodFrom(now: Date, period: PeriodKey): Date {
  const start = new Date(now);
  if (period === "today") start.setHours(0, 0, 0, 0);
  else start.setTime(now.getTime() - (period === "week" ? 7 : period === "month" ? 30 : 365) * DAY_MS);
  return start;
}

export function useDashboard(period: PeriodKey) {
  const gameId = useGameId();
  const [now, setNow] = useState(() => new Date());
  const today = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  useEffect(() => {
    const refresh = () => setNow(new Date());
    const schedule = () => {
      const current = new Date();
      const midnight = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
      return window.setTimeout(() => { refresh(); }, midnight.getTime() - current.getTime() + 100);
    };
    let timer = schedule();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const current = new Date();
      if (`${current.getFullYear()}-${current.getMonth()}-${current.getDate()}` !== today) refresh();
      window.clearTimeout(timer);
      timer = schedule();
    };
    window.addEventListener(DASHBOARD_REFRESH_EVENT, refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(DASHBOARD_REFRESH_EVENT, refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [today]);

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const to = now.toISOString();
  const from = periodFrom(now, period).toISOString();
  const query = useQuery({
    queryKey: dashboardQueryKeys.data(gameId, from, to, timeZone),
    queryFn: async () => {
      const response = await client.api.dashboard.$get({ query: { from, to, timeZone } }, gameId ? { headers: { "X-Game-Id": gameId } } : undefined);
      return rpcJson<DashboardResponse>(response);
    },
  });
  return { ...query, gameId, from, to, timeZone };
}

export function useDashboardRecap(sessionId: number | null | undefined, gameId: GameId | null | undefined) {
  return useQuery({
    queryKey: dashboardQueryKeys.recapById(sessionId ?? null, gameId ?? null),
    queryFn: async () => {
      if (sessionId == null || !gameId) throw new Error("useDashboardRecap: sessionId and gameId are required");
      return rpcJson<SessionRecap>(await client.api.dashboard.sessions[":id"].recap.$get({ param: { id: String(sessionId) } }, { headers: { "X-Game-Id": gameId } }));
    },
    enabled: sessionId != null && !!gameId,
  });
}
