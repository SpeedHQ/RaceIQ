import { raceIqAuthConfig } from "@speedhq/live-client";
import { useCallback, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { CancelSignInInput, ConnectInput, ConsentInput, DisplayNameInput, LeaderboardInput, OnlineMutationContext, PreferencesInput, RaceIqOnlinePort } from "@raceiq/online/contracts";
import type { OnlineUiHost } from "@raceiq/online/ui";
import { CloudLapImportRequestFailure, DriverSummaryBuilding, RaceIqOnlineProvider, requireCloudImportResponse, OnlineTransportFailure, isConnect, isOnlineCommandResult, isOnlineLeaderboard, isOnlineState, receiveOnlineResponse } from "@raceiq/online/ui";
import { client } from "@/lib/rpc";
import { m } from "../paraglide/messages";
import { getLocale } from "../paraglide/runtime";
import { routePrefixForGameId } from "../lib/game-routes";
import { uiStore } from "../stores/ui";
import { queryKeys } from "../hooks/query-keys";
import { dashboardQueryKeys } from "../hooks/dashboard";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

function call<T>(request: Promise<Pick<Response, "status" | "json">>, validate: (value: unknown) => value is T, expected: readonly number[]): Promise<T> {
  return request.then((response) => receiveOnlineResponse(response, validate, expected), () => { throw new OnlineTransportFailure("backend_unreachable"); });
}
const commandStatuses = [200, 400, 401, 403, 409, 429, 500, 503] as const;
const failureStatuses = [400, 401, 403, 409, 429, 500, 503] as const;
export const raceIqOnlinePort: RaceIqOnlinePort = {
  getState: () => call(client.api.online.state.$get(), isOnlineState, [200]),
  connect: (input: ConnectInput) => call(client.api.online.connect.$post({ json: input }), isConnect, [202, ...failureStatuses]),
  cancelSignIn: (input: CancelSignInInput) => call(client.api.online.connect.cancel.$post({ json: input }), isOnlineCommandResult, commandStatuses),
  acceptConsent: (input: ConsentInput) => call(client.api.online.consent.$put({ json: input }), isOnlineCommandResult, commandStatuses),
  setPreferences: (input: PreferencesInput) => call(client.api.online.preferences.$put({ json: input }), isOnlineCommandResult, commandStatuses),
  signOut: (input: OnlineMutationContext) => call(client.api.online["sign-out"].$post({ json: input }), isOnlineCommandResult, commandStatuses),
  setDisplayName: (input: DisplayNameInput) => call(client.api.online.profile.$put({ json: input }), isOnlineCommandResult, commandStatuses),
  getLeaderboard: (input: LeaderboardInput) => call(client.api.online.leaderboard.$get({ query: { trackId: input.trackId, carId: input.carId } }, { headers: { "X-Game-Id": input.gameId } }), isOnlineLeaderboard, [200]),
};

export const onlineUiHost: OnlineUiHost = {
  port: raceIqOnlinePort, cacheOnlineState: true,
  authHost: new URL(raceIqAuthConfig.supabaseUrl).hostname,
  m, getLocale, routePrefixForGameId,
  openSettings: (section) => uiStore.actions.openSettings(section),
  invalidateDashboard: (queryClient) => { void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.all }); },
  invalidateCaptureQueries: (queryClient) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.laps });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
  },
  useNavigateToReplay() {
    const navigate = useNavigate();
    return useCallback(async (lap) => {
      const prefix = routePrefixForGameId(lap.gameId);
      if (prefix) await navigate({ to: `/${prefix}/sessions/${lap.sessionId}/replay/${lap.id}` as never });
    }, [navigate]);
  },
  async getUploads(view, cursor, context, signal) {
    const response = await client.api.online.uploads.$get({ query: { view, ...(cursor ? { cursor } : {}), limit: "25", accountEpoch: context.accountEpoch, expectedRevision: String(context.expectedRevision) } }, { init: { signal } });
    if (response.status !== 200) throw new OnlineTransportFailure("backend_unreachable");
    return response.json();
  },
  async getDriverSummary(input, signal) {
    const response = await client.api["driver-summary"].$get({ query: { from: input.from, to: input.to } }, { headers: input.gameId ? { "X-Game-Id": input.gameId } : {}, init: { signal } });
    if (response.status === 202) throw new DriverSummaryBuilding();
    if (response.status !== 200) throw new OnlineTransportFailure("backend_unreachable");
    return response.json();
  },
  async getOnlineProfile(context, signal) {
    const response = await client.api.online.profile.$get({ query: { accountEpoch: context.accountEpoch, expectedRevision: String(context.expectedRevision) } }, { init: { signal } });
    if (response.status !== 200 && response.status !== 503) throw new OnlineTransportFailure("backend_unreachable");
    return response.json();
  },
  async getDriverBindings(signal) {
    const response = await client.api["driver-bindings"].$get(undefined, { init: { signal } });
    if (response.status !== 200) throw new OnlineTransportFailure("backend_unreachable");
    return response.json();
  },
  async confirmDriverBinding(input) {
    const response = await client.api["driver-bindings"].$put({ json: input });
    return receiveOnlineResponse(response, isOnlineCommandResult, commandStatuses);
  },
  async getCloudLapImport(context, signal) {
    const response = await client.api.online["lap-import"].$get({ query: { accountEpoch: context.accountEpoch, expectedRevision: String(context.expectedRevision) } }, { init: { signal } });
    if (response.status !== 200) {
      await requireCloudImportResponse(response, m);
      throw new CloudLapImportRequestFailure(m);
    }
    return response.json();
  },
  startCloudLapImport({ gameId, ...body }) {
    return client.api.online["lap-import"].$post({ json: body }, { headers: { "X-Game-Id": gameId } });
  },
  retryCloudLapImport: (input) => client.api.online["lap-import"].retry.$post({ json: input }),
  acknowledgeCloudLapImport: (input) => client.api.online["lap-import"].ack.$post({ json: input }),
  Avatar, AvatarFallback, AvatarImage, Button, Switch, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
};

export function OnlineHostProvider({ children, host = onlineUiHost }: { children: ReactNode; host?: OnlineUiHost }) {
  return <RaceIqOnlineProvider host={host}>{children}</RaceIqOnlineProvider>;
}
