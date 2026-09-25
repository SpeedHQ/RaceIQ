# Static Lap Analysis Catalog

Static lap analysis is deterministic, post-lap telemetry analysis. It emits `LapInsight` records; it does not call an AI model. Current persisted contract: `STATIC_LAP_ANALYSIS_VERSION = 3`. Segment metrics use `LAP_METRICS_ALGO_VERSION = 4`, including corrected signed Forza steering.

## Runtime contract

- Recording does not run static detectors.
- Opening a lap in Analyse computes missing or stale insights and persists them in `lap_metrics`.
- Lap AI/chat, comparison, and semantic replay reuse persisted current-version insights.
- Background driver-profile refresh reads cached insights only; explicit profile requests compute missing or stale insights.
- Explicit backfill and rerun operations may compute insights without opening Analyse.
- A lap needs at least one sixth of a second of usable recorded intervals.
- F1 emits several merged snapshots per simulation tick. Analysis keeps the last consecutive same-timestamp snapshot within a session, then maps findings back to original source-frame indices.

Each `LapInsight` contains:

| Field | Contract |
| --- | --- |
| `id` | Stable detector identifier. Wheel-specific families append `FL`, `FR`, `RL`, or `RR`. |
| `category` | `suspension`, `tires`, `driving`, or `mechanical`. |
| `severity` | `info`, `warning`, or `critical`, selected by detector-specific thresholds. |
| `label` / `detail` | Driver-facing summary and evidence. |
| `frameIndices` | Representative original source frames for timeline placement. |
| `evidenceSource` | Optional `native` or `inferred` provenance for aid and F1 observations. Inferred aid labels explicitly say “Possible”. |
| `timeLossS` | Optional conservative estimate. Absence means unquantified, not zero. Values overlap and MUST NOT be summed into a lap total. |

## Timing, capability, and evidence rules

- Event thresholds, merge gaps, lookahead, and duration severity use seconds, not frame counts. Only active sample duration satisfies minimum evidence; merged quiet gaps do not count.
- Positive timestamp intervals up to 100 ms contribute evidence. Invalid intervals and clock resets split events. No duration is extrapolated beyond the final packet. Ordinary duplicate F1 tick updates are coalesced before this check.
- Wheel-state detectors require direct continuous rotation telemetry. Authoritative per-wheel radii take precedence; otherwise calibration requires at least 0.5 s of clean moving coast with low controls/cornering and consistent rotations. Calibration freezes during traction events and resets after stops, dropouts, or time discontinuities. Uncalibrated states are unknown, not clean grip. F1 speed-derived wheel substitutes without MotionEx cannot establish traction.
- Acceleration references require calibrated four-wheel grip and at least one sixth of a second of clean full-throttle evidence per speed bin. Unknown traction cannot train the reference.
- Suspension overload/imbalance require a direct continuous physical normalized-stroke contract. AC Evo's display-scaled movement is not a physical end stop.
- Pressure detectors require direct continuous pressure. Tire-temperature findings require continuous telemetry; pit snapshots do not establish sustained lap heat.
- Thermal thresholds use canonical Celsius values with equivalent Fahrenheit conversion. These are generic thresholds, not validated compound-specific operating limits. Distinct surface/core identity is preserved.
- Surface profiles require a direct continuous inner/middle/outer contract. Persistent gradients describe measured heat distribution, not a proven camber or pressure error.
- Understeer, oversteer, and overshoot fallback use physical slip angles only for direct `tires.tire-slip-angle` bindings; otherwise they derive balance from speed, lateral acceleration, and yaw rate.
- Racing-line availability is evaluated locally within braking corners. Confident geometry showing no departure is not missing evidence. Curvature-direction changes reset outward-growth baselines.
- ACC/AC Evo use native ABS/TC intervention. Inference rejects known-disabled settings, unavailable wheel sources, and disturbance windows; TC additionally needs calibrated wheelspin. Activation count alone never establishes poor driving.
- Neutral post-braking, aid, exit, DRS/ERS, and tread-profile observations are excluded from driver-weakness ranking. Rapid pressure loss is an equipment observation, not a driver weakness.

## Suspension

| Emitted ID | Label | Detection summary | Severity |
| --- | --- | --- | --- |
| `susp-overload-{FL,FR,RL,RR}` | Suspension Overload | Physical normalized travel above `0.95` while moving above 7 m/s for at least `0.05 s`. Reports near-full travel, not confirmed impact damage. | Critical at 3+ events; otherwise warning. |
| `susp-imbalance` | Suspension Imbalance | At least 2 s above 7 m/s with low lateral acceleration, steering, and brake input; time-weighted left/right compression differs by more than `0.15`. Road banking remains a possible cause. | Critical above `0.25`; otherwise warning. |

## Tires

| Emitted ID | Label | Detection summary | Severity |
| --- | --- | --- | --- |
| `tire-overheat-{FL,FR,RL,RR}` | Tire Overheat | Moving wheel temperature above `110°C / 230°F` for at least `1/6 s` active evidence; gaps up to `0.5 s` may merge. | Critical only with at least `1/6 s` above `130°C / 266°F`; otherwise warning. |
| `tire-core-overheat-{FL,FR,RL,RR}` | Tire Core Overheat | Same thresholds for a separate continuous core layer; omitted when primary temperature already represents core. | Same sustained thresholds as primary heat. |
| `tire-surface-edge-imbalance-{FL,FR,RL,RR}` | Persistent Tire Edge Gradient | Inner/outer difference at least `10°C / 18°F`, same sign for 80% of each accepted 2 s window. Requires 3 separated windows, 3 s initial settling, stable average heat, and 60% persistence overall and in the later half. | Info; no setup diagnosis. |
| `tire-surface-pressure-shape-{FL,FR,RL,RR}` | Persistent Tire Tread Gradient | Center/shoulder difference at least `8°C / 14.4°F`, with the same persistence guards as edge gradients. Stable ID retained; pressure cause is not inferred. | Info; no setup diagnosis. |
| `tire-lockup-{FL,FR,RL,RR}` | Wheel Lockup | Calibrated wheel lockup for `1/12 s` active evidence; gaps up to `0.25 s` merge. | Critical at 3+ events; otherwise warning. |
| `tire-spin-{FL,FR,RL,RR}` | Wheelspin | Calibrated spin for `1/12 s` active evidence; gaps up to `0.25 s` merge. | Critical at 3+ events; otherwise warning. |
| `tire-wear-imbalance` | Wear Imbalance | Final reported tire-wear spread exceeds `0.15`; negative/unreported channels are ignored. | Critical above `0.30`; otherwise warning. |
| `tire-temp-split` | Front/Rear Temp Split | At least `5/3 s` valid moving evidence; time-weighted axle temperatures differ by at least `12°C / 21.6°F`. Prefers distinct core, then continuous primary temperature. | Warning above `22°C / 39.6°F`; otherwise info. |
| `tire-pressure-imbalance` | Tire Pressure Imbalance | At least `5/3 s` valid moving evidence; dominant axle's time-weighted left/right difference is at least `1.5 psi`. Rapid-loss evidence excludes the affected axle from that onset onward; earlier and unrelated axle evidence remains eligible. | Critical at `3 psi`; otherwise warning. |
| `tire-rapid-pressure-loss-{FL,FR,RL,RR}` | Rapid Tire Pressure Loss | Recent baseline from three stable 1 s windows; drop of at least `max(2 psi, 8%)`, exceeding peer/cooling effects by `1.5 psi`, confirmed for 2 s. Excludes pits, tire changes, invalid pressure, timing/session resets, and slow drift. | Warning; cause is not confirmed. |

## Driving — controls and traction

| Emitted ID | Label | Detection summary | Severity | Time loss |
| --- | --- | --- | --- | --- |
| `driving-abs-activation` | ABS Activation / Possible ABS Activation | Native intervention, active seconds, and observed braking duty; otherwise repeated wheel-speed trough/recovery pulses with source/settings/disturbance guards. | Info. | No |
| `driving-traction-control-activation` | Traction Control Activation / Possible Traction Control Activation | Native intervention and observed acceleration duty; otherwise repeated RPM cuts with independent calibrated wheelspin and stable controls/gear. Missing native channels do not count as observed inactive time. | Info. | No |
| `driving-brake-traction-loss` | Brake Traction Loss | Brake input at least `30/255` while a calibrated wheel is locked, for `0.05 s`. | Critical at 5+ events; warning at 2–4; otherwise info. | No |
| `driving-rev-limiter` | Rev Limiter | RPM within 50 RPM of engine maximum for at least `1/6 s`. | Warning at 5+ events; otherwise info. | Yes |
| `driving-coasting` | Coasting | Throttle and brake below `5/255` above 20 mph for at least `0.5 s`. Nearby braking prevents charging entry coasting. | Warning above 2 s total active time; otherwise info. | Yes |
| `driving-trail-brake` | Trail Braking | Brake zones lasting at least `0.05 s`; reports zones containing steering above 15. | Info. | No |
| `driving-early-braking` | Coast After Braking | At least `0.25 s` low throttle after brake release, then strong throttle while turning within `1.5 s`. Stable ID retained; no claim that braking was too early. | Info. | No |
| `driving-over-slowing` | Corner Speed Reduction | Speed falls at least 8% within 2 s after release, then throttle resumes while turning. Geometry/grip may require this; no excess-slowness diagnosis. | Info. | No |
| `driving-counter-steer` | Counter-Steer | Above 20 mph, opposite yaw/steering signs with yaw above `0.3 rad/s` and steering above 20 for `0.05 s`. | Critical at 5+ events; warning at 2–4; otherwise info. | No |
| `driving-throttle-traction-loss` | Throttle Traction Loss | Throttle at least `150/255` with calibrated wheelspin for `0.05 s`. | Critical at 5+ events; warning at 2–4; otherwise info. | No |
| `driving-early-throttle` | Corner Throttle Correction | Corner power above `100/255`, steering above 40, and speed above 30 mph, corroborated by spin, excess rotation, or corrective lift for `0.1 s`. | Warning at 5+ zones; otherwise info. | No |
| `driving-binary-throttle` | Abrupt Corner Throttle | Localized low→near-full→low reversal during one continuous turn; sustained high/low evidence and rapid release required. Flat-out occupancy is not a fault. | Warning at 3+ events; otherwise info. | No |
| `driving-delayed-throttle-pickup` | Low Throttle After Unwind | At least `0.6 s` low throttle after steering/lateral load reduce, stable motion/grip, and `0.5 s` clean lookahead. Rejects rebraking, linked turns, pits, noisy unwind, and known traction loss. No matched-corner reference is assumed. | Info. | No |
| `driving-unused-drs` | DRS Available but Closed | F1 observed eligibility transition, `0.5 s` response allowance, then at least 1 s closed under steady full-throttle straight-line demand. Temporary shifts/turning pause measurement without losing known eligibility. Faults, caution/pit states, gaps, missing guards, and frozen status values suppress claims. | Info. | No |

## Driving — advanced technique

| Emitted ID | Label | Detection summary | Severity | Time loss |
| --- | --- | --- | --- | --- |
| `driving-brake-drag` | Brake Drag | Throttle above 50% with brake between 0.5% and 25% for `0.25 s`. | Critical above 3 s total; warning above 1 s; otherwise info. | No |
| `driving-downshift-over-rev` | Aggressive Downshifts | Downshift followed within `0.3 s` by RPM at or above 97% of maximum. | Warning at 4+ events; otherwise info. | No |
| `driving-late-braking-overshoot` | Late Braking Overshoot | Hard braking/heavy steering above 30 mph, progressively more than `1.5 m` outside reference with over `1 m` outward growth, sustained `1/6 s`. Corner-local geometry; conservative front-scrub fallback only where geometry is unavailable. | Warning at 3+ corners; otherwise info. | No |
| `driving-understeer-scrub` | Understeer Scrub | Above 30 mph, steering above 25, understeer severity above `0.4` for `1/6 s`. | Warning at 4+ corners or above 3 s active time; otherwise info. | No |
| `driving-oversteer-slide` | Oversteer Slide | Above 30 mph, steering above 15, oversteer severity above `0.4` for `1/6 s`. | Warning at 4+ corners or above 3 s active time; otherwise info. | No |
| `driving-steering-sawing` | Steering Sawing | Above 40 mph, four meaningful steering-rate reversals within 1 s while steering exceeds 15; rate deadband `300 input units/s`. | Warning at 3+ zones; otherwise info. | No |
| `driving-throttle-micro-lifts` | Throttle Micro-Lifts | At least four drops of 60 input units within `0.1 s`, recovering toward the pre-lift level within `1/3 s`, with nearby calibrated rear spin. Moderate lifts need not cross an absolute low-throttle threshold. | Warning at 8+ lifts; otherwise info. | Yes |
| `driving-kerb-riding` | Hard Kerb Strikes | Above 30 mph, rumble contact and normalized suspension rate above `6/s`, or spike-only rate above `10.8/s`; `1/30 s` active evidence per event. At least three events. | Warning at 8+ events; otherwise info. | No |

## Mechanical

| Emitted ID | Label | Detection summary | Severity |
| --- | --- | --- | --- |
| `mech-fuel` | Fuel | Positive first/last fuel consumption and estimated laps remaining. | Critical below 3 laps remaining; warning below 5; otherwise info. |
| `mech-peak-power` | Peak Power | Maximum positive power, RPM, and gear. | Info. |
| `mech-boost-anomaly` | Boost Drop | Full-throttle boost below 50% of its rolling 1 s peak for `1/12 s`; reference resets across gear changes, throttle release, invalid boost, and timing discontinuities. | Critical at 3+ events; otherwise warning. |
| `mech-ers-depletion` | ERS Depletion Under Load | F1 prior positive store/deployment, then store below 2% of observed pre-depletion energy with electrical power and deployment rate below 20% of observed levels. Stable demand/mode/gear, positive prior evidence, and sustained confirmation required. | Info; no strategy-fault or guaranteed-loss claim. |

F1 source-packet ages are not retained in normalized telemetry. DRS/ERS require sequential status-value evidence and reject status values frozen for more than `0.5 s`; this is conservative evidence, not a claim of known source freshness. No brake-thermal detector is included.

## Inventory totals

- 38 detector families.
- 62 concrete IDs after expanding eight four-wheel families.
- 3 families may emit `timeLossS`: rev limiter, coasting, and throttle micro-lifts. No loss is invented for neutral corner observations or new detections.

## Persistence, versioning, and operations

`lap_metrics.insight_version` stores the detector contract. Current-version rows are reused; missing, malformed, or stale rows recompute on user-triggered analysis reads. Concurrent reads of one lap are deduplicated in-process.

When output changes, update detectors and focused behavioral tests, bump `STATIC_LAP_ANALYSIS_VERSION` in `server/lap-analysis/insights.ts`, and update this catalog. Segment-stat changes additionally bump `LAP_METRICS_ALGO_VERSION`. Existing rows become stale without destructive migration.

```http
POST /api/lap-insights/backfill
Content-Type: application/json

{"limit":100,"force":false}
```

Use returned `nextAfterLapId` for pagination. `force: false` processes missing/stale rows; `force: true` reruns selected rows.

```http
POST /api/laps/:id/insights/rerun
```

Forces recomputation regardless of stored version.

## Source of truth

- Dispatch and capability guards: `shared/racing/analysis/laps/insights/analyze.ts`
- Insight schema and event timing: `shared/racing/analysis/laps/insights/types.ts`
- Detectors: sibling `suspension.ts`, `tires.ts`, `driving-core.ts`, `driving-advanced.ts`, `electronics.ts`, and `mechanical.ts`
- Track-aware entry point and version: `server/lap-analysis/insights.ts`
- Persistence, cache, backfill, and rerun: `server/lap-analysis/metrics-store.ts`
