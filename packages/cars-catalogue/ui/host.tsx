import { createContext, useContext, type ReactNode } from "react";
import type { CarsCatalogueHost } from "../contracts/host";

const CarsCatalogueContext = createContext<CarsCatalogueHost | null>(null);

export function CarsCatalogueProvider({ value, children }: { value: CarsCatalogueHost; children: ReactNode }) {
  return <CarsCatalogueContext.Provider value={value}>{children}</CarsCatalogueContext.Provider>;
}

export function useCarsCatalogueHost(): CarsCatalogueHost {
  const host = useContext(CarsCatalogueContext);
  if (!host) throw new Error("Cars catalogue requires CarsCatalogueProvider");
  return host;
}
