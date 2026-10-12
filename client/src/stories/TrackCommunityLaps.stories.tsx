import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { LapManagement } from "../components/track/detail/LapManagement";
import type { TrackLapSortKey } from "../components/track/detail/types";
import { RaceIqOnlineProvider } from "../hooks/raceiq-online";
import { createOnlineFixturePort, privateFixture } from "./raceiq-online-fixtures";

function TrackLapScene() {
  const [selectedCars, setSelectedCars] = useState<Set<number>>(new Set());
  const [selectedLaps, setSelectedLaps] = useState<Set<number>>(new Set());
  const [selectedDivision, setSelectedDivision] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sortBy, setSortBy] = useState<TrackLapSortKey>("time");
  const [sortAsc, setSortAsc] = useState(true);
  return <main className="@container/workspace h-screen min-w-0 bg-app-bg p-4 text-app-text"><h1 className="sr-only">Preview circuit — Laps</h1><LapManagement
    track={{ id: "preview-track", ordinal: 5, name: "Preview circuit", variant: "Grand Prix", location: "Preview", country: "GB", lengthKm: 5.2, hasOutline: false, createdAt: null }}
    gameId="f1-2025" trackLaps={[]} filteredLaps={[]}
    uniqueCars={[{ carOrdinal: 1, carName: "Preview car", carClass: "F1" }, { carOrdinal: 2, carName: "Second preview car", carClass: "F1" }]}
    uniqueDivisions={[]} hasForzaTunes={false} hideClassCol selectedDivision={selectedDivision} setSelectedDivision={setSelectedDivision}
    selectedCars={selectedCars} setSelectedCars={setSelectedCars} toggleCar={(ordinal) => setSelectedCars((current) => { const next = new Set(current); if (next.has(ordinal)) next.delete(ordinal); else next.add(ordinal); return next; })}
    selectedLaps={selectedLaps} setSelectedLaps={setSelectedLaps} toggleLapSelect={(lapId) => setSelectedLaps((current) => new Set([...current, lapId]))} toggleAllLaps={() => setSelectedLaps(new Set())}
    sectorCount={3} isF125 hasSessionTypes={false} sessionLapCounts={new Map()} confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} deleting={false}
    handleBulkDelete={() => { throw new Error("No local laps exist in this presentation fixture"); }} sortBy={sortBy} sortAsc={sortAsc} handleSort={(column) => { setSortBy(column); setSortAsc((value) => !value); }}
  /></main>;
}
export function TrackCommunityLapsPreview() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  const [port] = useState(() => createOnlineFixturePort(privateFixture));
  const [router] = useState(() => createRouter({ routeTree: createRootRoute({ component: TrackLapScene }), history: createMemoryHistory({ initialEntries: ["/"] }) }));
  return <QueryClientProvider client={queryClient}><RaceIqOnlineProvider port={port}><RouterProvider router={router} /></RaceIqOnlineProvider></QueryClientProvider>;
}
const meta = { title: "Tracks/Community Laps", component: TrackCommunityLapsPreview, parameters: { layout: "fullscreen" } } satisfies Meta<typeof TrackCommunityLapsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PrivateReadableBoard: Story = {};
