export type SessionsTab = "mine" | "others";
export type SessionsSearch = { tab?: SessionsTab };

export function validateSessionsSearch(search: Record<string, unknown>): SessionsSearch {
  const tab = search.tab === "others" || search.tab === "mine" ? search.tab : search.tab === "recorded" || search.tab === "imported" ? "mine" : undefined;
  return { tab };
}
