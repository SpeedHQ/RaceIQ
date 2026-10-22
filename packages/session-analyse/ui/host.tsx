import { createContext, useContext, type ReactNode } from "react";
import type { SessionAnalyseHost } from "../contracts/ui";

const HostContext = createContext<SessionAnalyseHost | null>(null);
export function SessionAnalyseProvider({ host, children }: { host: SessionAnalyseHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}
export function useSessionAnalyseHost(): SessionAnalyseHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("SessionAnalyseProvider is required");
  return host;
}
