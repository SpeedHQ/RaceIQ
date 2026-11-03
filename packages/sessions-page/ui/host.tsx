import { createContext, useContext, type ReactNode } from "react";
import type { SessionsPageHost } from "../contracts";

const HostContext = createContext<SessionsPageHost | null>(null);
export function SessionsPageProvider({ host, children }: { host: SessionsPageHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}
export function useSessionsPageHost(): SessionsPageHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("SessionsPageProvider is required");
  return host;
}
