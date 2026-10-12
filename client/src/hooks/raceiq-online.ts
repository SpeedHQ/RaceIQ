import { raceIqAuthConfig } from "@speedhq/live-client";
import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { CancelledError, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CancelSignInInput, ConnectInput, ConnectResult, ConsentInput, LeaderboardInput, OnlineCommandResult, OnlineError, OnlineLeaderboard, OnlineMutationContext, OnlinePreferences, OnlineState, RaceIqOnlinePort } from "@raceiq/shared/integrations/raceiq-online";
import { isCurrentOnlineGeneration, isOnlineStateRevisionCurrent, OnlineTransportFailure, raceIqOnlinePort } from "../lib/raceiq-online";
import { queryKeys } from "./query-keys";

interface Snapshot { state?: OnlineState; generation: number; signOutPending: boolean; accountHidden: boolean; mutations: number; commandError: OnlineError | null; transportError: OnlineTransportFailure | null; }
interface OnlineSession { snapshot: Snapshot; listeners: Set<() => void>; signInPollingUntil?: number; }
const sessions = new WeakMap<QueryClient, WeakMap<RaceIqOnlinePort, OnlineSession>>();
function getSession(qc: QueryClient, port: RaceIqOnlinePort): OnlineSession {
  let byPort = sessions.get(qc);
  if (!byPort) { byPort = new WeakMap(); sessions.set(qc, byPort); }
  let session = byPort.get(port);
  if (!session) { session = { snapshot: { generation: 0, signOutPending: false, accountHidden: false, mutations: 0, commandError: null, transportError: null }, listeners: new Set() }; byPort.set(port, session); }
  return session;
}
function update(session: OnlineSession, change: Partial<Snapshot>): void { session.snapshot = { ...session.snapshot, ...change }; for (const listener of session.listeners) listener(); }
const PortContext = createContext<RaceIqOnlinePort>(raceIqOnlinePort);
export function RaceIqOnlineProvider({ port, children }: { port?: RaceIqOnlinePort; children: ReactNode }) {
  return createElement(PortContext.Provider, { value: port ?? raceIqOnlinePort, children });
}
const transport = (error: unknown) => error instanceof OnlineTransportFailure ? error : new OnlineTransportFailure("backend_unreachable");

export function useRaceIqOnline(options: { enabled?: boolean } = {}) {
  const port = useContext(PortContext);
  const qc = useQueryClient();
  const session = getSession(qc, port);
  const snapshot = useSyncExternalStore((listener) => { session.listeners.add(listener); return () => session.listeners.delete(listener); }, () => session.snapshot, () => session.snapshot);
  const visibility = useMemo(() => {
    let visible = typeof document === "undefined" || document.visibilityState === "visible";
    const listeners = new Set<() => void>();
    const onChange = () => { visible = document.visibilityState === "visible"; for (const listener of listeners) listener(); };
    return {
      get: () => visible,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      connect: () => { if (typeof document !== "undefined") document.addEventListener("visibilitychange", onChange); },
      disconnect: () => { if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onChange); },
    };
  }, []);
  useEffect(() => { visibility.connect(); return visibility.disconnect; }, [visibility]);
  const isVisible = useSyncExternalStore(visibility.subscribe, visibility.get, () => true);
  const applyState = (next: OnlineState): boolean => {
    const current = session.snapshot;
    const prior = current.state;
    if (current.signOutPending || current.accountHidden) return false;
    if (!isOnlineStateRevisionCurrent(prior, next)) return false;
    if (prior && prior.accountEpoch !== next.accountEpoch) {
      session.signInPollingUntil = next.connection.status === "signing_in" ? Date.now() + 120_000 : undefined;
      update(session, { generation: current.generation + 1, state: next, signOutPending: false, transportError: null });
      void qc.cancelQueries({ queryKey: ["raceiq-online"] });
      void qc.removeQueries({ queryKey: ["raceiq-online", "state"] });
      void qc.removeQueries({ queryKey: ["raceiq-online", "leaderboard"] });
      return true;
    }
    if (!prior) {
      if (next.connection.status === "signing_in") session.signInPollingUntil = Date.now() + 120_000;
      update(session, { generation: current.generation + 1, state: next, transportError: null });
      return true;
    }
    if (next.connection.status === "signing_in" && prior.connection.status !== "signing_in") session.signInPollingUntil = Date.now() + 120_000;
    if (next.connection.status !== "signing_in") session.signInPollingUntil = undefined;
    update(session, { state: next, transportError: null });
    return true;
  };
  const acceptCommandState = (next: OnlineState): void => {
    if (applyState(next)) qc.setQueryData(queryKeys.raceIqOnlineState(next.accountEpoch), next);
  };
  const stateQuery = useQuery({
    queryKey: queryKeys.raceIqOnlineState(snapshot.state?.accountEpoch ?? null),
    queryFn: async () => {
      const generation = session.snapshot.generation;
      try {
        const response = await port.getState();
        if (!isCurrentOnlineGeneration(generation, session.snapshot.generation) || !applyState(response)) throw new CancelledError({ silent: true });
        return response;
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        if (isCurrentOnlineGeneration(generation, session.snapshot.generation)) update(session, { transportError: transport(error) });
        throw error;
      }
    },
    enabled: options.enabled !== false && isVisible && !snapshot.signOutPending && !snapshot.accountHidden,
    refetchInterval: (query) => {
      if (!isVisible) return false;
      const current = query.state.data;
      if (current?.connection.status === "signing_in") return session.signInPollingUntil && Date.now() < session.signInPollingUntil ? 2_000 : 30_000;
      return current?.sync.status === "running" || current?.publicationWithdrawal.status === "pending" ? 2_000 : 30_000;
    },
    refetchIntervalInBackground: false,
    retry: (count, error) => count < 1 && error instanceof OnlineTransportFailure && error.retryable,
    refetchOnWindowFocus: true,
  });
  const refresh = async (): Promise<OnlineState | undefined> => {
    if (session.snapshot.accountHidden || session.snapshot.signOutPending) return undefined;
    const generation = session.snapshot.generation;
    try {
      const response = await port.getState();
      if (!isCurrentOnlineGeneration(generation, session.snapshot.generation) || !applyState(response)) return undefined;
      qc.setQueryData(queryKeys.raceIqOnlineState(response.accountEpoch), response);
      return response;
    } catch (error) {
      if (isCurrentOnlineGeneration(generation, session.snapshot.generation)) update(session, { transportError: transport(error) });
      return undefined;
    }
  };
  const mutate = async <R extends OnlineCommandResult | ConnectResult>(action: () => Promise<R>): Promise<R | undefined> => {
    const generation = session.snapshot.generation;
    update(session, { mutations: session.snapshot.mutations + 1, commandError: null, transportError: null });
    try {
      const response = await action();
      if (!isCurrentOnlineGeneration(generation, session.snapshot.generation)) return undefined;
      if (response.ok) acceptCommandState(response.state);
      else {
        update(session, { commandError: response.error });
        if (response.error.code === "stale_state") { await refresh(); return response; }
        acceptCommandState(response.state);
      }
      return response;
    } catch (error) {
      if (isCurrentOnlineGeneration(generation, session.snapshot.generation)) update(session, { transportError: transport(error) });
      return undefined;
    } finally { update(session, { mutations: Math.max(0, session.snapshot.mutations - 1) }); }
  };
  const context = (): OnlineMutationContext | undefined => session.snapshot.state ? { expectedRevision: session.snapshot.state.revision, accountEpoch: session.snapshot.state.accountEpoch } : undefined;
  const connect = async (preferences: OnlinePreferences): Promise<void> => {
    if (session.snapshot.accountHidden || session.snapshot.signOutPending) return;
    const current = session.snapshot.state;
    if (!current || current.policy.status !== "available") { update(session, { commandError: { code: "policy_unavailable", retryable: true, retryAfter: null } }); return; }
    let popup: Window | null = null;
    try { popup = window.open("about:blank", "_blank"); } catch { /* blocked */ }
    if (popup) popup.opener = null;
    const ctx = context();
    if (!ctx) { popup?.close(); return; }
    const input: ConnectInput = { ...ctx, acceptedPolicyVersions: current.policy.versions, preferences };
    const result = await mutate(() => port.connect(input));
    if (!result || !result.ok) { popup?.close(); return; }
    try {
      const url = new URL(result.authorizationUrl);
      const authHost = new URL(raceIqAuthConfig.supabaseUrl).hostname;
      if (url.protocol !== "https:" || url.hostname !== authHost || url.port || url.username || url.password || url.pathname !== "/auth/v1/authorize" || !popup || popup.closed) throw new Error();
      popup.location.replace(url.href);
    } catch {
      popup?.close();
      const cancel: CancelSignInInput = { expectedRevision: result.state.revision, accountEpoch: result.state.accountEpoch, flowId: result.flowId };
      const cancellationGeneration = session.snapshot.generation;
      try {
        const cancelled = await port.cancelSignIn(cancel);
        if (!isCurrentOnlineGeneration(cancellationGeneration, session.snapshot.generation)) return;
        acceptCommandState(cancelled.state);
      } catch (error) {
        if (!isCurrentOnlineGeneration(cancellationGeneration, session.snapshot.generation)) return;
        update(session, { transportError: transport(error) });
      }
      update(session, { commandError: { code: "external_open_failed", retryable: false, retryAfter: null } });
    }
  };
  const runCommand = async (request: (ctx: OnlineMutationContext) => Promise<OnlineCommandResult>): Promise<void> => {
    const ctx = context();
    if (!ctx || session.snapshot.signOutPending || session.snapshot.accountHidden) return;
    await mutate(() => request(ctx));
  };
  const cancelSignIn = async (): Promise<void> => {
    const current = session.snapshot.state;
    if (current?.connection.status === "signing_in") {
      const flowId = current.connection.flowId;
      await runCommand((ctx) => port.cancelSignIn({ ...ctx, flowId }));
    }
  };
  const acceptConsent = async (): Promise<void> => {
    const current = session.snapshot.state;
    if (current?.policy.status !== "available") { update(session, { commandError: { code: "policy_unavailable", retryable: true, retryAfter: null } }); return; }
    const acceptedPolicyVersions = current.policy.versions;
    const ctx = context();
    if (ctx) await runCommand(() => port.acceptConsent({ ...ctx, acceptedPolicyVersions } satisfies ConsentInput));
  };
  const setPreferences = async (preferences: OnlinePreferences): Promise<void> => runCommand((ctx) => port.setPreferences({ ...ctx, preferences }));
  const signOut = async (): Promise<void> => {
    const ctx = context();
    if (!ctx) return;
    if (session.snapshot.signOutPending) return;
    const generation = session.snapshot.generation + 1;
    update(session, { generation, signOutPending: true, accountHidden: true, commandError: null, transportError: null });
    await qc.cancelQueries({ queryKey: ["raceiq-online"] });
    await qc.removeQueries({ queryKey: ["raceiq-online", "leaderboard"] });
    await qc.removeQueries({ queryKey: ["raceiq-online", "state"] });
    try {
      const response = await port.signOut(ctx);
      if (!isCurrentOnlineGeneration(generation, session.snapshot.generation)) return;
      if (response.ok && response.state.connection.status === "signed_out") {
        update(session, { state: response.state, signOutPending: false, accountHidden: false, commandError: null, transportError: null });
        qc.setQueryData(queryKeys.raceIqOnlineState(response.state.accountEpoch), response.state);
        await qc.removeQueries({ queryKey: ["raceiq-online", "leaderboard"] });
      } else {
        const current = session.snapshot.state;
        const acceptResponse = isOnlineStateRevisionCurrent(current, response.state);
        const changedEpoch = acceptResponse && response.state.accountEpoch !== current?.accountEpoch;
        update(session, { state: acceptResponse ? response.state : current, generation: changedEpoch ? session.snapshot.generation + 1 : session.snapshot.generation, signOutPending: false, accountHidden: true, commandError: response.ok ? { code: "internal_error", retryable: true, retryAfter: null } : response.error });
      }
    } catch (error) { if (isCurrentOnlineGeneration(generation, session.snapshot.generation)) update(session, { signOutPending: false, accountHidden: true, transportError: transport(error) }); }
  };
  return { state: snapshot.signOutPending || snapshot.accountHidden ? undefined : snapshot.state, isPending: options.enabled !== false && stateQuery.isPending && !stateQuery.error && !snapshot.state && !snapshot.accountHidden, transportError: snapshot.transportError ?? (stateQuery.error instanceof OnlineTransportFailure ? stateQuery.error : null), commandError: snapshot.commandError, isMutating: snapshot.mutations > 0, signOutPending: snapshot.signOutPending, accountHidden: snapshot.accountHidden, refresh, connect, cancelSignIn, acceptConsent, setPreferences, signOut };
}

export function useOnlineLeaderboard(input: LeaderboardInput | null) {
  const port = useContext(PortContext);
  const online = useRaceIqOnline({ enabled: true });
  const session = getSession(useQueryClient(), port);
  const epoch = online.state?.accountEpoch ?? null;
  const generation = session.snapshot.generation;
  const query = useQuery<OnlineLeaderboard>({
    queryKey: queryKeys.raceIqOnlineLeaderboard(input?.gameId ?? "", input?.trackId ?? "", input?.carId ?? "", epoch),
    queryFn: async () => {
      if (!input) throw new OnlineTransportFailure("invalid_response");
      const startedAtGeneration = session.snapshot.generation;
      const board = await port.getLeaderboard(input);
      if (!isCurrentOnlineGeneration(startedAtGeneration, session.snapshot.generation) || !isCurrentOnlineGeneration(generation, startedAtGeneration) || session.snapshot.signOutPending || session.snapshot.accountHidden) throw new CancelledError({ silent: true });
      if (board.key.gameId !== input.gameId || board.key.trackId !== input.trackId || board.key.carId !== input.carId) throw new OnlineTransportFailure("invalid_response");
      return board;
    },
    enabled: input !== null && !!online.state && !online.signOutPending && !online.accountHidden,
    retry: (count, error) => count < 1 && error instanceof OnlineTransportFailure && error.retryable,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });
  return online.signOutPending || online.accountHidden ? { ...query, data: undefined } : query;
}
