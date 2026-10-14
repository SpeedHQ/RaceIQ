import { raceIqAuthConfig } from "@speedhq/live-client";
import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { CancelledError, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CancelSignInInput, ConnectInput, ConnectResult, ConsentInput, DisplayNameInput, LeaderboardInput, OnlineCommandResult, OnlineError, OnlineLeaderboard, OnlineMutationContext, OnlinePreferences, OnlineState, RaceIqOnlinePort } from "@raceiq/online/contracts";
import { clearOnlineStateCache, readOnlineStateCache, writeOnlineStateCache } from "../lib/raceiq-online-state-cache";
import { isCurrentOnlineGeneration, isOnlineStateRevisionCurrent, OnlineTransportFailure, raceIqOnlinePort } from "../lib/raceiq-online";
import { queryKeys } from "./query-keys";

interface Snapshot { state?: OnlineState; isCachedState: boolean; generation: number; signOutPending: boolean; accountHidden: boolean; mutations: number; commandError: OnlineError | null; transportError: OnlineTransportFailure | null; leaderboardGeneration: number; leaderboardAccess: boolean; privacyBarrier: boolean; privateAckRevision?: number; }
interface OnlineSession { snapshot: Snapshot; listeners: Set<() => void>; signInPollingUntil?: number; }
const sessions = new WeakMap<QueryClient, WeakMap<RaceIqOnlinePort, OnlineSession>>();
function getSession(qc: QueryClient, port: RaceIqOnlinePort): OnlineSession {
  let byPort = sessions.get(qc);
  if (!byPort) { byPort = new WeakMap(); sessions.set(qc, byPort); }
  let session = byPort.get(port);
  if (!session) {
    const cached = port === raceIqOnlinePort ? readOnlineStateCache() : undefined;
    session = { snapshot: { state: cached, isCachedState: !!cached, generation: 0, signOutPending: false, accountHidden: false, mutations: 0, commandError: null, transportError: null, leaderboardGeneration: 0, leaderboardAccess: false, privacyBarrier: false }, listeners: new Set() };
    byPort.set(port, session);
  }
  return session;
}
function update(session: OnlineSession, change: Partial<Snapshot>): void { session.snapshot = { ...session.snapshot, ...change }; for (const listener of session.listeners) listener(); }
const leaderboardAllowed = (state: OnlineState | undefined): boolean => !!state && state.connection.status === "connected" && state.consent.status === "accepted" && state.preferences?.visibility === "public" && state.preferencePersistence === "confirmed";
function syncLeaderboardAccess(session: OnlineSession, state = session.snapshot.state): boolean {
  const allowed = leaderboardAllowed(state) && !session.snapshot.signOutPending && !session.snapshot.accountHidden && !session.snapshot.privacyBarrier;
  if (allowed === session.snapshot.leaderboardAccess) return allowed;
  update(session, { leaderboardAccess: allowed, leaderboardGeneration: session.snapshot.leaderboardGeneration + 1 });
  return allowed;
}
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
    if (!isOnlineStateRevisionCurrent(current.isCachedState && current.generation === 0 ? undefined : prior, next)) return false;
    if (current.privacyBarrier && current.privateAckRevision !== undefined && next.revision > current.privateAckRevision && leaderboardAllowed(next)) {
      update(session, { privacyBarrier: false, privateAckRevision: undefined });
    }
    if (prior && prior.accountEpoch !== next.accountEpoch) {
      session.signInPollingUntil = next.connection.status === "signing_in" ? Date.now() + 120_000 : undefined;
      if (port === raceIqOnlinePort) {
        if (prior) clearOnlineStateCache();
        writeOnlineStateCache(next);
      }
      update(session, { generation: current.generation + 1, state: next, isCachedState: false, signOutPending: false, transportError: null });
      void qc.cancelQueries({ queryKey: ["raceiq-online"] });
      void qc.removeQueries({ queryKey: ["raceiq-online", "state"] });
      void qc.removeQueries({ queryKey: ["raceiq-online", "leaderboard"] });
      syncLeaderboardAccess(session, next);
      return true;
    }
    if (!prior) {
      if (next.connection.status === "signing_in") session.signInPollingUntil = Date.now() + 120_000;
      if (port === raceIqOnlinePort) writeOnlineStateCache(next);
      update(session, { generation: current.generation + 1, state: next, isCachedState: false, transportError: null });
      syncLeaderboardAccess(session, next);
      return true;
    }
    if (next.connection.status === "signing_in" && prior.connection.status !== "signing_in") session.signInPollingUntil = Date.now() + 120_000;
    if (next.connection.status !== "signing_in") session.signInPollingUntil = undefined;
    if (port === raceIqOnlinePort) writeOnlineStateCache(next);
    update(session, { state: next, generation: current.generation || 1, isCachedState: false, transportError: null });
    syncLeaderboardAccess(session, next);
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
        if (isCurrentOnlineGeneration(generation, session.snapshot.generation)) update(session, { transportError: transport(error), isCachedState: !!session.snapshot.state, leaderboardAccess: false, leaderboardGeneration: session.snapshot.leaderboardGeneration + 1 });
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
      if (isCurrentOnlineGeneration(generation, session.snapshot.generation)) update(session, { transportError: transport(error), isCachedState: !!session.snapshot.state, leaderboardAccess: false, leaderboardGeneration: session.snapshot.leaderboardGeneration + 1 });
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
      if (isCurrentOnlineGeneration(generation, session.snapshot.generation)) update(session, { transportError: transport(error), isCachedState: !!session.snapshot.state, leaderboardAccess: false, leaderboardGeneration: session.snapshot.leaderboardGeneration + 1 });
      return undefined;
    } finally { update(session, { mutations: Math.max(0, session.snapshot.mutations - 1) }); }
  };
  const context = (): OnlineMutationContext | undefined => session.snapshot.state ? { expectedRevision: session.snapshot.state.revision, accountEpoch: session.snapshot.state.accountEpoch } : undefined;
  const connect = async (): Promise<ConnectResult | undefined> => {
    if (session.snapshot.accountHidden || session.snapshot.signOutPending || session.snapshot.mutations > 0) return undefined;
    if (session.snapshot.isCachedState || session.snapshot.transportError || !session.snapshot.state) await refresh();
    if (session.snapshot.isCachedState || session.snapshot.transportError || !session.snapshot.state) return undefined;
    let popup: Window | null = null;
    try { popup = window.open("about:blank", "_blank"); } catch { /* blocked */ }
    if (popup) popup.opener = null;
    update(session, { mutations: session.snapshot.mutations + 1 });
    try {
      if (!context()) await refresh();
      const ctx = context();
      if (!ctx) { popup?.close(); return undefined; }
      const input: ConnectInput = { ...ctx };
      const result = await mutate(() => port.connect(input));
      if (!result || !result.ok) { popup?.close(); return result; }
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
          if (!isCurrentOnlineGeneration(cancellationGeneration, session.snapshot.generation)) return undefined;
          acceptCommandState(cancelled.state);
        } catch (error) {
          if (!isCurrentOnlineGeneration(cancellationGeneration, session.snapshot.generation)) return undefined;
          update(session, { transportError: transport(error) });
        }
        update(session, { commandError: { code: "external_open_failed", retryable: false, retryAfter: null } });
        return undefined;
      }
      return result;
    } finally { update(session, { mutations: Math.max(0, session.snapshot.mutations - 1) }); }
  };
  const runCommand = async (request: (ctx: OnlineMutationContext) => Promise<OnlineCommandResult>): Promise<OnlineCommandResult | undefined> => {
    const ctx = context();
    if (!ctx || session.snapshot.isCachedState || session.snapshot.transportError || session.snapshot.state?.service !== "available" || session.snapshot.signOutPending || session.snapshot.accountHidden) return undefined;
    return mutate(() => request(ctx));
  };
  const cancelSignIn = async (): Promise<OnlineCommandResult | undefined> => {
    const current = session.snapshot.state;
    if (current?.connection.status === "signing_in") {
      const flowId = current.connection.flowId;
      return runCommand((ctx) => port.cancelSignIn({ ...ctx, flowId }));
    }
    return undefined;
  };
  const acceptConsent = async (): Promise<OnlineCommandResult | undefined> => {
    if (!session.snapshot.state || session.snapshot.isCachedState || session.snapshot.transportError || session.snapshot.state.service !== "available") return undefined;
    const current = session.snapshot.state;
    if (current.policy.status !== "available") { update(session, { commandError: { code: "policy_unavailable", retryable: true, retryAfter: null } }); return undefined; }
    const acceptedPolicyVersions = current.policy.versions;
    const ctx = context();
    if (ctx) return runCommand(() => port.acceptConsent({ ...ctx, acceptedPolicyVersions } satisfies ConsentInput));
    return undefined;
  };
  const setPreferences = async (preferences: OnlinePreferences): Promise<OnlineCommandResult | undefined> => {
    if (session.snapshot.isCachedState || session.snapshot.transportError || session.snapshot.state?.service !== "available") return undefined;
    if (preferences.visibility === "private") {
      update(session, { privacyBarrier: true, privateAckRevision: undefined, leaderboardAccess: false, leaderboardGeneration: session.snapshot.leaderboardGeneration + 1 });
    }
    const result = await runCommand((ctx) => port.setPreferences({ ...ctx, preferences }));
    if (preferences.visibility === "private" && result?.ok) {
      update(session, { privacyBarrier: true, privateAckRevision: result.state.revision, leaderboardAccess: false });
    } else if (preferences.visibility === "public" && result?.ok && leaderboardAllowed(result.state)) {
      update(session, { privacyBarrier: false, privateAckRevision: undefined });
      syncLeaderboardAccess(session, result.state);
    }
    return result;
  };
  const setDisplayName = async (displayName: string): Promise<OnlineCommandResult | undefined> => {
    if (session.snapshot.isCachedState || session.snapshot.transportError || session.snapshot.state?.service !== "available") return undefined;
    return runCommand((ctx) => port.setDisplayName({ ...ctx, displayName } satisfies DisplayNameInput));
  };
  const signOut = async (): Promise<void> => {
    const ctx = context();
    if (!ctx) return;
    if (session.snapshot.signOutPending) return;
    const generation = session.snapshot.generation + 1;
    if (port === raceIqOnlinePort) clearOnlineStateCache();
    update(session, { generation, signOutPending: true, accountHidden: true, isCachedState: false, commandError: null, transportError: null, leaderboardAccess: false, leaderboardGeneration: session.snapshot.leaderboardGeneration + 1 });
    await qc.cancelQueries({ queryKey: ["raceiq-online"] });
    await qc.removeQueries({ queryKey: ["raceiq-online", "leaderboard"] });
    await qc.removeQueries({ queryKey: ["raceiq-online", "state"] });
    try {
      const response = await port.signOut(ctx);
      if (!isCurrentOnlineGeneration(generation, session.snapshot.generation)) return;
      if (response.ok && response.state.connection.status === "signed_out") {
        if (port === raceIqOnlinePort) writeOnlineStateCache(response.state);
        update(session, { state: response.state, isCachedState: false, signOutPending: false, accountHidden: false, commandError: null, transportError: null });
        qc.setQueryData(queryKeys.raceIqOnlineState(response.state.accountEpoch), response.state);
        await qc.removeQueries({ queryKey: ["raceiq-online", "leaderboard"] });
      } else {
        const current = session.snapshot.state;
        const acceptResponse = isOnlineStateRevisionCurrent(current, response.state);
        const changedEpoch = acceptResponse && response.state.accountEpoch !== current?.accountEpoch;
        if (port === raceIqOnlinePort && acceptResponse && response.state.connection.status === "signed_out") writeOnlineStateCache(response.state);
        update(session, { state: acceptResponse ? response.state : current, isCachedState: false, generation: changedEpoch ? session.snapshot.generation + 1 : session.snapshot.generation, signOutPending: false, accountHidden: true, commandError: response.ok ? { code: "internal_error", retryable: true, retryAfter: null } : response.error });
      }
    } catch (error) { if (isCurrentOnlineGeneration(generation, session.snapshot.generation)) update(session, { signOutPending: false, accountHidden: true, isCachedState: false, transportError: transport(error) }); }
  };
  const state = snapshot.signOutPending || snapshot.accountHidden ? undefined : snapshot.state;
  const transportError = snapshot.transportError ?? (stateQuery.error instanceof OnlineTransportFailure ? stateQuery.error : null);
  const canAuthenticate = !!state && !snapshot.isCachedState && !transportError && !snapshot.signOutPending && !snapshot.accountHidden;
  const canMutate = !!state && canAuthenticate && state.service === "available" && state.connection.status === "connected" && state.policy.status === "available";
  return { state, isCachedState: snapshot.isCachedState, canAuthenticate, canMutate, isPending: options.enabled !== false && stateQuery.isPending && !stateQuery.error && !snapshot.state && !snapshot.accountHidden, transportError, commandError: snapshot.commandError, isMutating: snapshot.mutations > 0, signOutPending: snapshot.signOutPending, accountHidden: snapshot.accountHidden, refresh, connect, cancelSignIn, acceptConsent, setPreferences, setDisplayName, signOut };
}

export function useOnlineLeaderboard(input: LeaderboardInput | null) {
  const port = useContext(PortContext);
  const online = useRaceIqOnline({ enabled: true });
  const qc = useQueryClient();
  const session = getSession(qc, port);
  const epoch = online.state?.accountEpoch ?? null;
  const generation = session.snapshot.generation;
  const allowed = !online.isCachedState && leaderboardAllowed(online.state) && !online.signOutPending && !online.accountHidden && !session.snapshot.privacyBarrier && session.snapshot.leaderboardAccess;
  const key = queryKeys.raceIqOnlineLeaderboard(input?.gameId ?? "", input?.trackId ?? "", input?.carId ?? "", epoch);
  const query = useQuery<OnlineLeaderboard>({
    queryKey: key,
    queryFn: async () => {
      if (!input || !allowed || !session.snapshot.leaderboardAccess) throw new CancelledError({ silent: true });
      const startedAtGeneration = session.snapshot.generation;
      const startedLeaderboardGeneration = session.snapshot.leaderboardGeneration;
      const board = await port.getLeaderboard(input);
      if (!session.snapshot.leaderboardAccess || !isCurrentOnlineGeneration(startedLeaderboardGeneration, session.snapshot.leaderboardGeneration) || !isCurrentOnlineGeneration(startedAtGeneration, session.snapshot.generation) || !isCurrentOnlineGeneration(generation, startedAtGeneration) || session.snapshot.signOutPending || session.snapshot.accountHidden) throw new CancelledError({ silent: true });
      if (board.key.gameId !== input.gameId || board.key.trackId !== input.trackId || board.key.carId !== input.carId) throw new OnlineTransportFailure("invalid_response");
      return board;
    },
    enabled: input !== null && allowed,
    retry: (count, error) => count < 1 && error instanceof OnlineTransportFailure && error.retryable,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (allowed) return;
    void qc.cancelQueries({ queryKey: key });
    void qc.removeQueries({ queryKey: key });
  }, [allowed, qc, key[1], key[2], key[3], key[4]]);
  if (!allowed) {
    return { ...query, accessAllowed: false, data: undefined, isPending: false, refetch: async () => ({ ...query, data: undefined }) };
  }
  return { ...query, accessAllowed: true };
}
