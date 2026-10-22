import { createContext, useContext, type ReactNode } from "react";
import type { TracksCatalogueHost } from "../contracts/host";

const HostContext = createContext<TracksCatalogueHost | null>(null);
export function TracksCatalogueProvider({ host, children }: { host: TracksCatalogueHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}
export function useTracksCatalogueHost(): TracksCatalogueHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("TracksCatalogueProvider is required");
  return host;
}
