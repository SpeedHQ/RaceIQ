import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { CompareTrackMap } from './src/components/comparison/CompareTrackMap';
import { buildIRacingMeasuredMapPaths } from './src/components/comparison/iracing-map-path';
import { GameRouteProvider } from './src/stores/game';
import { SessionAnalyseProvider } from '../packages/session-analyse/ui/host';
import { SessionAnalysePage } from '../packages/session-analyse/ui/SessionAnalysePage';
import { IRacingIncidentReport } from './src/components/iracing/IRacingIncidentReport';
import { m } from './src/paraglide/messages';
import type { SessionAnalyseHost } from '../packages/session-analyse/contracts/ui';
import type { AlignedTrace } from '../shared/racing/comparison/types';
import './src/index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const distances = [0, 25, 50, 75, 100];
const gps = { lapId: 1, trackOrigin: { latitude: 53, longitude: -2 }, samples: distances.map((distance, index) => ({ latitude: 53 + index * 0.0001, longitude: -2 + index * 0.0001, fraction: index / 4 })) };
const outline = [{x:0,z:0},{x:100,z:0},{x:100,z:100},{x:0,z:100},{x:0,z:0}];
for (const id of [1, 2]) queryClient.setQueryData(['iracing-track-map-telemetry',id,'iracing'], { ...gps, lapId: id, samples: [] });
const traces = { distance: distances, elapsedTimeA: [0,1,2,3,4], elapsedTimeB: [0,1,2,3,4], positionXA: [1,25,50,75,100], positionZA: [1,25,50,75,100], positionXB: [2,26,51,76,101], positionZB: [2,26,51,76,101], yawA: [0,0,0,0,0], yawB: [0,0,0,0,0], speedA: [20,20,20,20,20], speedB: [20,20,20,20,20], throttleA: [0,0,0,0,0], throttleB: [0,0,0,0,0], brakeA: [0,0,0,0,0], brakeB: [0,0,0,0,0] } as unknown as AlignedTrace;
const invalidLap = { id: 1, sessionId: 480, lapNumber: 1, lapTime: 90, isValid: false, invalidReason: 'track limits', classification: 'timed', carId: '42', trackId: '99', gameId: 'iracing', processing: { state: 'ready' } };
const ready = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: async () => {} });
const host = {
  m, Button: (props: React.ComponentProps<'button'>) => <button {...props} />, IRacingIncidentReport,
  useGameId: () => 'iracing', useSessions: () => ready([{id:480, carId:'42', trackId:'99',lapCount:1, processing:{state:'ready'}}]),
  useSessionLaps: () => ready([invalidLap]), useTrackName: () => ready('Fixture Circuit'), useResolveNames: () => ready({trackNames:{},carNames:{}}), useCarName: () => ready('Fixture Car'),
  fetchReviewLaps: async () => [invalidLap], getGameRoute: () => '/iracing',
} as unknown as SessionAnalyseHost; // Only hooks reached by the no-valid-laps branch are needed.
function App() {
 const cursor = useRef<number | null>(null), redraw = useRef<(() => void) | null>(null);
 const [gpsLoaded, setGpsLoaded] = useState(false);
 return <main style={{padding:24}}><h1>PR 480 production-component reproductions</h1>
 <section id="map"><h2>Comparison: no calibration</h2><button id="load-gps" onClick={() => {for (const id of [1,2]) queryClient.setQueryData(['iracing-track-map-telemetry',id,'iracing'], {...gps,lapId:id}); setGpsLoaded(true);}}>Load measured GPS</button><output id="map-fixture">{gpsLoaded ? `Measured paths: ${buildIRacingMeasuredMapPaths([gps,gps], distances).filter(Boolean).length}; calibration: absent` : 'No measured GPS; calibration: absent'}</output>
 <div style={{height:500,width:800}}><CompareTrackMap outline={outline} outlineBounds={null} traces={traces} lapAId={1} lapBId={2} labelA="A" labelB="B" lapTimeA="4" lapTimeB="4" segments={[]} hoveredDistanceRef={cursor} redrawRef={redraw} gameId="iracing" trackProjection={null}/></div></section>
 <section id="incidents"><h2>Session 480: one recorded invalid lap</h2><SessionAnalyseProvider host={host}><SessionAnalysePage gameId="iracing" sessionId={480}/></SessionAnalyseProvider></section>
 </main>;
}
const root = createRootRoute();
const route = createRoute({getParentRoute:()=>root,path:'/.pr480-repro.html',component:App});
const router = createRouter({routeTree:root.addChildren([route])});
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><GameRouteProvider value="iracing"><RouterProvider router={router}/></GameRouteProvider></QueryClientProvider>);
