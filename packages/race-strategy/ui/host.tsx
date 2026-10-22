import { createContext, useContext, type ReactNode } from "react";
import type { RaceStrategyHost } from "../contracts";

const HostContext = createContext<RaceStrategyHost | null>(null);
export function RaceStrategyProvider({ value, children }: { value: RaceStrategyHost; children: ReactNode }) {
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}
export function useRaceStrategyHost(): RaceStrategyHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("Race strategy UI requires its application host provider");
  return host;
}
