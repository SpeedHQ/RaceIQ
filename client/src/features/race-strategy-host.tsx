import type { ReactNode } from "react";
import { RaceStrategyProvider } from "@raceiq/race-strategy/ui";
import type { RaceStrategyHost } from "@raceiq/race-strategy/contracts";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "../components/ui/dialog";
import { useSessions } from "../hooks/session-queries";
import { useSettings } from "../hooks/settings";
import { useTelemetryStore } from "../stores/telemetry";
import { client } from "../lib/rpc";
import { rpcJson } from "../lib/rpc-json";
import { m } from "../paraglide/messages";

const sessionApi = client.api.sessions[":id"];
const host = {
  m, Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
  useSessions, useSettings, useTelemetryState: useTelemetryStore,
  api: {
    listPlans: async (gameId, signal) => rpcJson<unknown>(await client.api["race-plans"].$get({ query: { gameId } }, { init: { signal } })),
    activePlan: async (signal) => rpcJson<unknown>(await client.api["race-plans"].active.$get({}, { init: { signal } })),
    savePlan: async (input, id) => rpcJson<unknown>(id
      ? await client.api["race-plans"][":id"].$put({ param: { id }, json: input })
      : await client.api["race-plans"].$post({ json: input })),
    deletePlan: async (id) => rpcJson<unknown>(await client.api["race-plans"][":id"].$delete({ param: { id } })),
    setActivePlan: async (planId) => rpcJson<unknown>(await client.api["race-plans"].active.$put({ json: { planId } })),
    stints: async (gameId, sessionId) => rpcJson<unknown>(await sessionApi.stints.$get({ param: { id: String(sessionId) }, query: {} }, { headers: { "X-Game-Id": gameId } })),
    estimates: async (gameId, sessionId, driverKey, cursor) => rpcJson<unknown>(await sessionApi["pit-estimates"].$get({ param: { id: String(sessionId) }, query: { driverKey: driverKey ?? undefined, before: cursor ?? undefined, limit: "25" } }, { headers: { "X-Game-Id": gameId } })),
    baseline: async (gameId, sessionId, stintId) => rpcJson<unknown>(await sessionApi["strategy-baseline"].$get({ param: { id: String(sessionId) }, query: { stintId } }, { headers: { "X-Game-Id": gameId } })),
    clearEstimates: async (gameId, sessionId, driverKey) => rpcJson<unknown>(await sessionApi["pit-estimates"].$delete({ param: { id: String(sessionId) }, json: { driverKey } }, { headers: { "X-Game-Id": gameId } })),
  },
} satisfies RaceStrategyHost;

export function RaceStrategyHostProvider({ children }: { children: ReactNode }) {
  return <RaceStrategyProvider value={host}>{children}</RaceStrategyProvider>;
}
