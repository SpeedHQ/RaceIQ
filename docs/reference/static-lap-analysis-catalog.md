# Static Lap Analysis Catalog

Static lap analysis is deterministic, post-lap telemetry analysis. It emits `LapInsight` records; it does not call an AI model. Current persisted contract: `STATIC_LAP_ANALYSIS_VERSION = 2`.

## Runtime contract

- Recording does not run static detectors.
- Opening a lap in Analyse computes missing or stale insights and persists them in `lap_metrics`.
- Lap AI/chat, comparison, and semantic replay reuse persisted current-version insights.
- Driver-profile refresh reads cached insights only; it never computes missing insights during recording.
- Explicit backfill and rerun operations may compute insights without opening Analyse.
- A lap with fewer than 10 telemetry frames produces no insights.

Each `LapInsight` contains:

| Field | Contract |
| --- | --- |
| `id` | Stable detector identifier. Wheel-specific families append `FL`, `FR`, `RL`, or `RR`. |
| `category` | `suspension`, `tires`, `driving`, or `mechanical`. |
| `severity` | `info`, `warning`, or `critical`, selected by detector-specific thresholds. |
| `label` / `detail` | Driver-facing summary and evidence. |
| `frameIndices` | Representative source frames for timeline placement. |
| `timeLossS` | Optional conservative estimate. Absence means unquantified, not zero. Values overlap and MUST NOT be summed into a lap total. |

## Capability and fallback rules

- Wheel-state detectors run only when the game adapter exposes usable wheel-rotation telemetry.
- Tire-pressure imbalance runs only for direct, continuously fresh pressure telemetry.
- Tire-temperature findings require continuous telemetry. Pit snapshots and static temperature channels do not count as sustained lap heat.
- When surface and core temperatures are distinct, overheat detection evaluates both layers and front/rear balance prefers core temperature.
- Inner/middle/outer surface-profile findings require all three bands, at least 100 valid samples above 15 mph, and a direct continuously fresh profile contract.
- Understeer, oversteer, and late-braking fallback logic use physical slip angles only when the adapter binds direct `tires.tire-slip-angle` values. Otherwise they derive balance from speed, lateral acceleration, and yaw rate.
- Late-braking overshoot prefers bundled `track.racing-line` geometry. Missing track identity/data uses the conservative hard-brake plus understeer fallback.
- ACC and AC Evo use native ABS/traction-control intervention channels. Other games use wheel-speed or RPM-pulse inference.

## Suspension

| Emitted ID | Label | Detection summary | Severity |
| --- | --- | --- | --- |
| `susp-overload-{FL,FR,RL,RR}` | Suspension Overload | Normalized travel above `0.95` for at least 3 consecutive frames. One insight per affected wheel. | Critical at 3+ events; otherwise warning. |
| `susp-imbalance` | Suspension Imbalance | Mean left/right normalized suspension compression differs by more than `0.15`. | Critical above `0.25`; otherwise warning. |

## Tires

| Emitted ID | Label | Detection summary | Severity |
| --- | --- | --- | --- |
| `tire-overheat-{FL,FR,RL,RR}` | Tire Overheat | Wheel temperature exceeds `110°C`/`250°F` for at least 10 frames; events within 30 frames merge. | Critical when peak exceeds `130°C`/`300°F`; otherwise warning. |
| `tire-core-overheat-{FL,FR,RL,RR}` | Tire Core Overheat | Separate core temperature exceeds `110°C`/`250°F` for at least 10 frames; emitted only when core is distinct from the primary temperature semantic. | Critical when peak exceeds `130°C`/`300°F`; otherwise warning. |
| `tire-surface-edge-imbalance-{FL,FR,RL,RR}` | Tire Surface Edge Imbalance | Persistent inner/outer surface difference is at least `10°C`/`18°F` across 100 valid moving samples. | Critical at `20°C`/`36°F`; otherwise warning. |
| `tire-surface-pressure-shape-{FL,FR,RL,RR}` | Tire Surface Pressure Shape | Persistent center-versus-shoulders surface difference is at least `8°C`/`14.4°F` across 100 valid moving samples. | Critical at `15°C`/`27°F`; otherwise warning. |
| `tire-lockup-{FL,FR,RL,RR}` | Wheel Lockup | Derived wheel state remains `lockup` for at least 5 frames; events within 15 frames merge. Requires wheel-rotation capability. | Critical at 3+ events; otherwise warning. |
| `tire-spin-{FL,FR,RL,RR}` | Wheelspin | Derived wheel state remains `spin` for at least 5 frames; events within 15 frames merge. Requires wheel-rotation capability. | Critical at 3+ events; otherwise warning. |
| `tire-wear-imbalance` | Wear Imbalance | Final reported tire-wear spread exceeds `0.15`; negative/unreported channels are ignored. | Critical above `0.30`; otherwise warning. |
| `tire-temp-split` | Front/Rear Temp Split | At least 100 samples above 15 mph; average axle temperatures differ by `12°C`/`25°F` or more. Prefers a distinct core layer, then continuous primary temperature. | Warning above `22°C`/`45°F`; otherwise info. |
| `tire-pressure-imbalance` | Tire Pressure Imbalance | At least 100 valid samples above 15 mph; dominant axle's average left/right difference is at least `1.5 psi`. Requires direct continuous pressures. | Critical at `3 psi` or more; otherwise warning. |

## Driving — controls and traction

| Emitted ID | Label | Detection summary | Severity | Time loss |
| --- | --- | --- | --- | --- |
| `driving-abs-activation` | ABS Activation | Native intervention events on ACC/AC Evo; otherwise repeated wheel-speed deceleration/recovery pulses under braking. | Warning at 5+ events; otherwise info. | No |
| `driving-traction-control-activation` | Traction Control Activation | Native intervention events on ACC/AC Evo; otherwise repeated RPM cuts under sustained throttle in a stable gear. | Warning at 5+ events; otherwise info. | No |
| `driving-brake-traction-loss` | Brake Traction Loss | Brake input at least `30/255` while any derived wheel state is locked, sustained for 3 frames. Requires wheel rotation. | Critical at 5+ events; warning at 2–4; otherwise info. | No |
| `driving-rev-limiter` | Rev Limiter | RPM stays within 50 RPM of engine maximum for at least 10 frames. | Warning at 5+ events; otherwise info. | Yes |
| `driving-coasting` | Coasting | Throttle and brake below `5/255` above 20 mph for at least 30 frames. Coasts leading into braking remain uncharged. | Warning above 120 total frames; otherwise info. | Yes |
| `driving-trail-brake` | Trail Braking | Reports brake zones lasting at least 3 frames and counts zones containing steering above 15. | Info. | No |
| `driving-early-braking` | Early Braking | After brake release: at least 15 low-throttle frames, then strong throttle while steering within 1.5 seconds. | Warning at 4+ corners; otherwise info. | Yes |
| `driving-over-slowing` | Over-Slowed Corner | Speed drops at least 8% after brake release, then throttle resumes while substantial steering remains. | Warning at 4+ corners; otherwise info. | Yes |
| `driving-counter-steer` | Counter-Steer | Above 20 mph, yaw and steering have opposite signs with yaw above `0.3 rad/s` and steering above 20 for at least 3 frames. | Critical at 5+ events; warning at 2–4; otherwise info. | No |
| `driving-throttle-traction-loss` | Throttle Traction Loss | Throttle at least `150/255` while any derived wheel state spins, sustained for 3 frames. Requires wheel rotation. | Critical at 5+ events; warning at 2–4; otherwise info. | No |
| `driving-early-throttle` | Early Throttle | Throttle above `100/255`, steering above 40, and speed above 30 mph for at least 5 frames. | Warning at 5+ zones; otherwise info. | No |
| `driving-binary-throttle` | Binary Throttle | Across at least 100 frames above 15 mph, over 70% of throttle samples are below 10% or above 90%. | Warning above 90%; otherwise info. | No |

## Driving — advanced technique

| Emitted ID | Label | Detection summary | Severity | Time loss |
| --- | --- | --- | --- | --- |
| `driving-brake-drag` | Brake Drag | Throttle above 50% with brake between 0.5% and 25% for at least 15 frames. | Critical above 3 seconds total; warning above 1 second; otherwise info. | No |
| `driving-downshift-over-rev` | Aggressive Downshifts | A downshift is followed within 0.3 seconds by RPM at or above 97% of maximum. | Warning at 4+ events; otherwise info. | No |
| `driving-late-braking-overshoot` | Late Braking Overshoot | Under hard braking and steering above 30 mph, car moves progressively more than 1.5 m outside reference line; fallback requires strong understeer. | Warning at 3+ corners; otherwise info. | No |
| `driving-understeer-scrub` | Understeer Scrub | Above 30 mph with steering above 25, sustained understeer severity above `0.4` for at least 10 frames. | Warning at 4+ corners or above 180 total frames; otherwise info. | No |
| `driving-oversteer-slide` | Oversteer Slide | Above 30 mph with steering above 15, sustained oversteer severity above `0.4` for at least 10 frames. | Warning at 4+ corners or above 180 total frames; otherwise info. | No |
| `driving-steering-sawing` | Steering Sawing | Above 40 mph, at least four meaningful steering-direction reversals per second while steering exceeds 15. | Warning at 3+ zones; otherwise info. | No |
| `driving-throttle-micro-lifts` | Throttle Micro-Lifts | Near-full throttle drops sharply and recovers within 20 frames, with nearby rear-wheel spin; at least 4 lifts required. Requires wheel rotation. | Warning at 8+ lifts; otherwise info. | Yes |
| `driving-kerb-riding` | Hard Kerb Strikes | Above 30 mph, rumble-strip contact plus suspension spike above `0.10`; without rumble data, spike must exceed `0.18`. At least 3 events required. | Warning at 8+ events; otherwise info. | No |

## Mechanical

| Emitted ID | Label | Detection summary | Severity |
| --- | --- | --- | --- |
| `mech-fuel` | Fuel | Reports positive fuel consumption and estimated laps remaining from first/last packet values. | Critical below 3 laps remaining; warning below 5; otherwise info. |
| `mech-peak-power` | Peak Power | Reports maximum positive power, RPM, and gear. | Info. |
| `mech-boost-anomaly` | Boost Drop | At full throttle (`Accel > 240`), boost falls below 50% of its rolling 60-frame peak for at least 5 frames. | Critical at 3+ events; otherwise warning. |

## Inventory totals

- 34 detector families.
- 55 concrete IDs after expanding seven four-wheel families: suspension overload, primary and core overheat, surface edge and pressure shape, lockup, and wheelspin.
- 5 families may emit `timeLossS`: rev limiter, coasting, early braking, over-slowing, and throttle micro-lifts.

## Persistence, versioning, and operations

`lap_metrics.insight_version` stores the detector contract used for each lap. Current-version rows are reused. Missing, malformed, or stale rows recompute on a user-triggered analysis read. Concurrent requests for the same lap are deduplicated in-process.

When detector output changes:

1. Update detector and focused tests.
2. Bump `STATIC_LAP_ANALYSIS_VERSION` in `server/lap-analysis/insights.ts`.
3. Update this catalog when IDs, thresholds, capability rules, labels, severity, or time-loss behavior changed.
4. Existing rows become stale automatically; no destructive migration is required.

Operational endpoints:

```http
POST /api/lap-insights/backfill
Content-Type: application/json

{"limit":100,"afterLapId":0,"force":false}
```

Use returned `nextAfterLapId` for the next page. `force: false` processes missing/stale rows; `force: true` reruns every selected row.

```http
POST /api/laps/:id/insights/rerun
```

This forces one lap to recompute regardless of stored version.

## Source of truth

- Dispatch and capability guards: `shared/racing/analysis/laps/insights/analyze.ts`
- Insight schema and event grouping: `shared/racing/analysis/laps/insights/types.ts`
- Detectors: sibling `suspension.ts`, `tires.ts`, `driving-core.ts`, `driving-advanced.ts`, `electronics.ts`, and `mechanical.ts`
- Track-aware entry point and version: `server/lap-analysis/insights.ts`
- Persistence, cache, backfill, and rerun: `server/lap-analysis/metrics-store.ts`
