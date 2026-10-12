import { hc } from "hono/client";
import type { AppType } from "@raceiq/backend/routes/index";

let csrfToken: string | null = null;
export function setCsrfToken(value: string | null) { csrfToken = value; }

export const client = hc<AppType>("/", {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes((init?.method ?? "GET").toUpperCase())) headers.set("X-RaceIQ-CSRF", csrfToken);
    const response = await fetch(input, { ...init, headers, credentials: "same-origin" });
    // The browser has already replaced the session cookie at this point.
    // Replace its matching CSRF token before another write can be dispatched.
    if (response.ok && response.headers.has("x-raceiq-csrf")) setCsrfToken(response.headers.get("x-raceiq-csrf") || null);
    if (response.status === 401 && !String(input).includes("/api/auth/")) window.dispatchEvent(new Event("raceiq-auth-required"));
    return response;
  },
});
