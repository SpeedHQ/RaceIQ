import type { InferResponseType } from "hono/client";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import { client, getSessionMutationGeneration, setCsrfToken } from "./rpc";
import { queryClient } from "./queryClient";
import { applyLocale } from "./locale";
import { getLocale, isLocale } from "@/paraglide/runtime";
import { setClientErrorReportingEnabled } from "./report-error";

export type AuthStatus = InferResponseType<typeof client.api.auth.status.$get>;
export class DashboardAuthUnavailable extends Error {
  constructor(cause: unknown) { super("access_unavailable", { cause }); }
}
let localeInitialized = false;

let statusRequest: { generation: number; promise: Promise<AuthStatus> } | null = null;
async function readDashboardAuth(): Promise<AuthStatus> {
  const generation = getSessionMutationGeneration();
  const response = await client.api.auth.status.$get();
  if (generation !== getSessionMutationGeneration()) return loadDashboardAuth();
  if (!response.ok) throw new Error("access_unavailable");
  const status = await response.json();
  if (generation !== getSessionMutationGeneration()) return loadDashboardAuth();
  if (!status.authenticated) queryClient.clear();
  setCsrfToken(status.csrf);
  setClientErrorReportingEnabled(status.authenticated);
  if ((!localeInitialized || !status.pending) && isLocale(status.language) && getLocale() !== status.language) {
    applyLocale(status.language);
  }
  localeInitialized = true;
  return status;
}
export function loadDashboardAuth(): Promise<AuthStatus> {
  const generation = getSessionMutationGeneration();
  if (!statusRequest || statusRequest.generation !== generation) {
    const promise = readDashboardAuth().catch((error: unknown) => {
      if (generation !== getSessionMutationGeneration()) return loadDashboardAuth();
      setClientErrorReportingEnabled(false);
      setCsrfToken(null);
      queryClient.clear();
      throw new DashboardAuthUnavailable(error);
    }).finally(() => {
      if (statusRequest?.promise === promise) statusRequest = null;
    });
    statusRequest = { generation, promise };
  }
  return statusRequest.promise;
}


export function useDashboardAuth() {
  const { auth: status } = useRouteContext({ from: "__root__" });
  const router = useRouter();
  return { status, refresh: async () => { await router.invalidate(); } };
}

// Only allow an in-app destination, never a protocol-relative or external URL.
export function dashboardReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || ["/login", "/onboarding"].includes(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
