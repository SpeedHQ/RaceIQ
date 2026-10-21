import type { ReactNode } from "react";
import { CarsCatalogueProvider } from "@raceiq/cars-catalogue/ui";
import type { Car, CarsCatalogueHost, IRacingCatalogueCar, LMUCatalogueCar } from "@raceiq/cars-catalogue/contracts";
import { PiBadge } from "../components/forza/PiBadge";
import { AppInput } from "../components/ui/AppInput";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { SortableTableHead } from "../components/ui/sortable-table-head";
import { getCarModel, loadCarModelConfigs } from "../data/car-models";
import { useUnits } from "../hooks/useUnits";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";
import { m } from "../paraglide/messages";
import { getLocale } from "../paraglide/runtime";
import { useRequiredGameId } from "../stores/game";

const host = {
  m,
  getLocale,
  useRequiredGameId,
  useUnits,
  loadCarModelConfigs,
  getCarModel,
  async loadCars(gameId) {
    const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": gameId } });
    if (!response.ok) throw await errorFromResponse(response);
    return response.json() as Promise<Car[]>;
  },
  loadAccCars: () => client.api.acc.cars.$get().then((response) => response.json()),
  loadAcEvoCars: () => client.api["ac-evo"].cars.$get().then((response) => response.json()),
  async loadIRacingCars() {
    const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": "iracing" } });
    if (!response.ok) throw await errorFromResponse(response);
    return response.json() as Promise<IRacingCatalogueCar[]>;
  },
  async loadLMUCars() {
    const response = await client.api.cars.$get({}, { headers: { "X-Game-Id": "lmu" } });
    if (!response.ok) throw await errorFromResponse(response);
    return response.json() as Promise<LMUCatalogueCar[]>;
  },
  PiBadge,
  AppInput,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SortableTableHead,
} satisfies CarsCatalogueHost;

export function CarsCatalogueHostProvider({ children }: { children: ReactNode }) {
  return <CarsCatalogueProvider value={host}>{children}</CarsCatalogueProvider>;
}
