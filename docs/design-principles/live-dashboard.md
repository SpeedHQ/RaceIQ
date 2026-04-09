# Live Dashboard Design Principles

## Core Philosophy

The live dashboard is a **state viewer only**. It displays real-time telemetry and session information with zero responsibility for calculations, logic, or state management.

## Architecture

```
Game (UDP/Shared Memory)
         ↓
    Server (Bun)
    - Receives packets
    - Parses telemetry
    - Computes session state:
      * Lap detection
      * Sector timing
      * Pit window estimates
      * Fuel/tire projections
      * Corner detection
      * Race position tracking
         ↓
    WebSocket Broadcast
         ↓
    Zustand Store (Client)
    - Caches latest packet
    - Stores sectors data
    - Stores pit estimates
    - Stores server status
         ↓
    Live Dashboard (React)
    - Reads from Zustand
    - Renders UI
    - NO CALCULATIONS
```

## Rules

### 1. **Live Dashboard is Display-Only**
- Render data received from Zustand
- Never perform calculations
- Never track state locally
- Never maintain derived data

✅ **Good:**
```tsx
function LapTimes({ packet, sectors }) {
  // Just render server-computed data
  return (
    <div>
      <span>{formatLapTime(packet.CurrentLap)}</span>
      <span>{formatLapTime(sectors?.estimatedLap)}</span>
    </div>
  );
}
```

❌ **Bad:**
```tsx
function LapTimes({ packet }) {
  // DON'T compute estimated lap on client
  const [avgLapTime, setAvgLapTime] = useState(0);
  useEffect(() => {
    // Computing lap estimates locally = wrong place
    setAvgLapTime(computeEstimate());
  }, [packet]);
  // ...
}
```

### 2. **All Calculations Happen on Server**
- Pit window estimates → `PitTracker` (server)
- Sector timing → `SectorTracker` (server)
- Lap detection → `LapDetector` (server)
- Fuel/tire projections → `PitTracker` (server)
- Estimated lap time → `SectorTracker` (server)

The server broadcasts the **result** via WebSocket. The client never re-computes.

### 3. **Zustand Store is the Single Source of Truth**
- Live dashboard reads **only** from Zustand
- Never make direct WebSocket calls
- Never cache additional state locally in components
- Use `useTelemetryStore()` for:
  - `packet` - current telemetry
  - `sectors` - server-computed sector data
  - `pit` - server-computed pit window data
  - `serverStatus` - session info

✅ **Good:**
```tsx
const packet = useTelemetryStore((s) => s.packet);
const pit = useTelemetryStore((s) => s.pit);
// Render pit.pitInLaps, pit.tireEstimates, etc.
```

❌ **Bad:**
```tsx
// Don't maintain your own copy of state
const [localPit, setLocalPit] = useState(null);
useEffect(() => {
  socket.on('pit-update', setLocalPit);
}, []);
```

### 4. **Shared Components Accept Data as Props**
- Components like `PitEstimate`, `SectorTimes`, `LapTimes` are stateless
- They receive data and render it
- Each game (fm-2023, f1-2025, acc) uses the same components
- No game-specific logic in components

Example: `PitEstimate` works for all games because it only renders data passed to it.

### 5. **WebSocket Updates Flow: Server → Zustand → Component Re-renders**
1. Server computes new state (e.g., new pit window estimate)
2. Server broadcasts via WebSocket
3. Zustand store receives and updates
4. Component subscribes via hook, gets new reference
5. React re-renders with new data
6. UI reflects latest server state

**The client never initiates calculations.** It is purely reactive.

## Common Mistakes to Avoid

| Mistake | Problem | Solution |
|---------|---------|----------|
| Computing pit estimates on client | Out of sync with server | Use `pit` from Zustand |
| Tracking lap times locally | Duplicates server logic | Use `sectors` from Zustand |
| Using `useState` for telemetry data | Adds latency, breaks sync | Read directly from Zustand |
| Calculating fuel/tire projections in components | Client can't see all laps | Rely on `pit.tireEstimates` |
| Caching data in ref/component memory | Becomes stale | Always read fresh from Zustand |
| Different dashboards computing differently | Race condition, confusion | One source: server |

## Benefits of This Architecture

1. **Single source of truth** — Server is authoritative, no inconsistency
2. **Minimal client code** — Dashboard is just a renderer
3. **Easy to test** — Server logic is deterministic, client is trivial
4. **Fast iteration** — Change calculation on server, all games get fix
5. **Consistency across games** — Same components, different telemetry sources
6. **Real-time accuracy** — Client never falls behind server state

## When Adding a Feature

Ask yourself:

- **Does this require computation?** → Implement on server, add to WebSocket broadcast
- **Does this need to persist or be stateful?** → Part of server session state, store in database
- **Is this displaying what the server sent?** → Implement in dashboard component
- **Does this need multiple packets/history?** → Server aggregates, client displays result

## Example: Adding Tire Pressure Display

❌ **Wrong approach:**
```tsx
// On client
useEffect(() => {
  const pressures = [];
  packets.forEach(p => pressures.push(p.tyrePressure));
  setPressureHistory(pressures); // NO!
}, [packets]);
```

✅ **Right approach:**
```tsx
// Server: already tracking pressure in PitTracker
// Server: includes in pit data broadcast
// Client: 
function TirePressure() {
  const pit = useTelemetryStore(s => s.pit);
  return <div>{pit?.tyrePressure}</div>;
}
```

## Architecture Diagram

```
┌─────────────────┐
│  Game Process   │
│  (UDP/Memory)   │
└────────┬────────┘
         │ packets @ 60Hz
         ▼
    ┌────────────────────────┐
    │   Server (Session)      │
    │ ┌──────────────────────┐│
    │ │ Receive + Parse      ││
    │ │ Detect laps          ││
    │ │ Calculate sectors    ││
    │ │ Estimate pit window  ││
    │ │ Track fuel/tires     ││
    │ │ Detect corners       ││
    │ └──────────────────────┘│
    └────────┬────────────────┘
             │ broadcast @ 30Hz
             │ {packet, sectors, pit}
             ▼
    ┌────────────────────────┐
    │  Zustand Store         │
    │ (Client Cache)         │
    │ - packet               │
    │ - sectors              │
    │ - pit                  │
    │ - serverStatus         │
    └────────┬────────────────┘
             │ subscribe & re-render
             ▼
    ┌────────────────────────┐
    │  Live Dashboard        │
    │  (React Components)    │
    │  ┌──────────────────┐  │
    │  │ PitEstimate      │  │
    │  │ SectorTimes      │  │
    │  │ LapTimes         │  │
    │  │ TireHealth       │  │
    │  └──────────────────┘  │
    └────────────────────────┘
```

## References

- `server/sector-tracker.ts` - Sector timing computation
- `server/sector-tracker.ts:PitTracker` - Pit window estimation
- `client/src/stores/telemetry.ts` - Zustand store definition
- `client/src/components/telemetry/` - Shared dashboard components
- `client/src/components/LivePage.tsx` - fm-2023 reference implementation
- `client/src/components/f1/F1LiveDashboard.tsx` - f1-2025 following same pattern
