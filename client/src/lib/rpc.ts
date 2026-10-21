import { hc } from "hono/client";
import type { AppType } from "@raceiq/backend/routes/index";

let csrfToken: string | null = null;
let sessionMutationGeneration = 0;
export function setCsrfToken(value: string | null) { csrfToken = value; }
export function getSessionMutationGeneration() { return sessionMutationGeneration; }

function requestPath(input: RequestInfo | URL): string {
  const value = input instanceof Request ? input.url : String(input);
  return new URL(value, typeof window === "undefined" ? "http://localhost" : window.location.origin).pathname;
}

export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-RaceIQ-CSRF", csrfToken);
  const response = await fetch(input, { ...init, headers, credentials: "same-origin" });
  if (response.ok && requestPath(input).startsWith("/api/auth/") && method !== "GET") sessionMutationGeneration++;
  if (response.ok && response.headers.has("x-raceiq-csrf")) setCsrfToken(response.headers.get("x-raceiq-csrf") || null);
  if (response.status === 401 && !requestPath(input).startsWith("/api/auth/")) window.dispatchEvent(new Event("raceiq-auth-required"));
  return response;
}

export const client = hc<AppType>("/", {
  fetch: authenticatedFetch,
});
