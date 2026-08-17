# 3D Wireframe and Car Model Definitions

`CarScene.tsx` renders car body, tires, suspension, drivetrain, load visualization, and track overlays. Model geometry comes from `client/src/data/car-models.ts`; renderer components must not add car-specific dimensions.

## Coordinate system

- `+X`: forward
- `+Y`: up
- `+Z`: right
- Distances: metres
- Angles: radians

Raw telemetry roll and pitch rotate complete vehicle, including wheels and running gear. When raw attitude channel is unavailable, normalized suspension travel supplies chassis-only roll or pitch. Springs span transformed chassis hardpoints to wheel-side mounts in full 3D.

## Definition locations

Built-in definitions and defaults live in `client/src/data/car-models.ts`:

- `DEFAULT_CAR`: fallback body, tire, suspension, and spring geometry
- `DEFAULT_SPRING`: fields inherited by partial front/rear spring definitions
- `F1_CAR`, `DEMO_CAR`: bundled model definitions
- `resolveCarModelDefinition()`: deep-merges model and spring defaults

Runtime per-car definitions load from `%APPDATA%/raceiq/car-model-configs.json`. Object keys are simulator car ordinals. An entry must include `modelPath` to select its GLB. Bundled GLBs live in `client/public/models` and use `/models/<file>.glb` URLs.

## Example

```json
{
  "1234": {
    "modelPath": "/models/example.glb",
    "halfWheelbase": 1.42,
    "halfFrontTrack": 0.82,
    "halfRearTrack": 0.8,
    "bodyLength": 4.7,

    "frontTireRadius": 0.34,
    "rearTireRadius": 0.36,
    "frontTireWidth": 0.29,
    "rearTireWidth": 0.32,

    "suspStroke": 0.1,

    "frontSpring": {
      "bodyMountHeight": 0.25,
      "inboardOffset": 0.32,
      "coilRadius": 0.026,
      "coils": 7,
      "damperExtension": 0.06
    },
    "rearSpring": {
      "bodyMountHeight": 0.27,
      "inboardOffset": 0.3,
      "coilRadius": 0.03,
      "coils": 6,
      "damperExtension": 0.065
    },

    "glbWheelbase": 2.84,
    "glbOffsetX": 0,
    "glbOffsetY": -0.04,
    "glbOffsetZ": 0,
    "glbRotationY": 0
  }
}
```

## Fields

### Body and tires

| Field                               | Meaning                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `modelPath`                         | GLB URL. Required for per-car model selection.                              |
| `halfWheelbase`                     | Geometric center to front/rear axle.                                        |
| `halfFrontTrack`                    | Centerline to front tire center.                                            |
| `halfRearTrack`                     | Centerline to rear tire center.                                             |
| `bodyLength`                        | Overall body length used for GLB autoscaling when `glbWheelbase` is absent. |
| `tireRadius`                        | Shared tire-radius fallback.                                                |
| `frontTireRadius`, `rearTireRadius` | Axle-specific tire radii.                                                   |
| `frontTireWidth`, `rearTireWidth`   | Axle-specific tire widths.                                                  |
| `suspStroke`                        | Full compressed-to-extended suspension travel.                              |

### Front and rear springs

`frontSpring` and `rearSpring` accept same fields independently. Each object is partial; omitted fields inherit `DEFAULT_SPRING`.

| Field             | Meaning                                              | Default |
| ----------------- | ---------------------------------------------------- | ------: |
| `bodyMountHeight` | Chassis-side mount height above wheel center.        |  `0.23` |
| `inboardOffset`   | Distance from tire center toward chassis centerline. |  `0.35` |
| `coilRadius`      | Rendered coil radius.                                | `0.032` |
| `coils`           | Rendered coil count.                                 |     `6` |
| `damperExtension` | Damper rod overhang beyond each mount.               |  `0.05` |

### GLB alignment

| Field                                    | Meaning                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `glbWheelbase`                           | Wheelbase measured in source GLB coordinates; enables exact wheelbase scaling. |
| `glbOffsetX`, `glbOffsetY`, `glbOffsetZ` | Post-scale model alignment offsets.                                            |
| `glbRotationY`                           | Yaw correction for source models using different forward axis.                 |
| `solidHiddenMeshes`                      | Mesh indices omitted from solid-body rendering, normally source-model tires.   |

## Adding a model

1. Add GLB and license file under `client/public/models`.
2. Measure wheelbase, front/rear tracks, and tire dimensions from source model or vehicle specifications.
3. Add built-in definition in `client/src/data/car-models.ts`, or add car-ordinal entry to runtime `car-model-configs.json`.
4. Set `glbWheelbase` when source wheelbase is known; otherwise body length controls scale.
5. Tune GLB offsets before changing wheel or suspension geometry. Offsets align artwork; geometry fields represent vehicle measurements.
6. Verify front/rear wheels, spring mounts, drivetrain, and body remain aligned under roll, pitch, steering, and suspension travel.

## Suspension roadmap

Implement in this order. Do not label inferred range saturation as physical bottom-out or top-out without a model/setup limit.

### Model definitions and rendering

- [ ] Extend front/rear suspension definitions with shock body radius/length, shaft radius, bump-stop length, compression limit, and droop limit.
- [ ] Render separate damper body, moving shaft, and bump stop along each transformed spring axis.
- [ ] Drive shaft position from physical suspension or shock deflection when available; fall back to normalized travel and model `suspStroke`.
- [ ] Show bump-stop contact, near-limit travel, and confirmed limit contact with distinct states.

### Additional suspension hardware

Keep generic models mechanically neutral. Draw linkage only when model definition contains measured pickup points; wrong wishbone or pushrod geometry is worse than omitting it.

#### Core

- [ ] Add per-corner upright/hub definitions so wheel-side suspension, steering, brake, and driveshaft mounts share one transformed reference.
- [ ] Add model-selectable double-wishbone, MacPherson-strut, multi-link, trailing-arm, torsion-beam, solid-axle, and live-axle layouts.
- [ ] Render upper/lower control arms or model-specific links between chassis pickup points and upright mounts.
- [ ] Render steering tie rods and animate inferred steering movement; do not imply measured toe or Ackermann when only normalized steer input exists.
- [ ] Extend front/rear definitions with anti-roll-bar center position, torsion-section width/diameter, arm length, blade angle, drop-link mounts, and optional motion ratio/rate.
- [ ] Render ARB torsion section, rotating arms, and drop links; animate inferred twist from left-right suspension displacement.

#### Model-specific

- [ ] Add pushrod/pullrod, rocker, and inboard spring/damper layouts for formula and prototype cars.
- [ ] Add third/heave spring and damper assemblies only when model/setup data identifies them.
- [ ] Add torsion springs, helper/tender springs, packers, and separate bump stops where vehicle design or setup data supports them.
- [ ] Add axle housing, Panhard rod, Watts linkage, radius arms, and leaf springs for solid/live-axle cars.
- [ ] Add static subframe and suspension mounting structures only when they clarify pickup-point geometry without obscuring telemetry.

#### Diagnostic overlays

- [ ] Resolve setup ARB setting, rate, diameter, blade/arm adjustment, and connected/disconnected state where catalog fidelity supports each field.
- [ ] Calculate ARB torque or wheel-load contribution only when physical rate, arm geometry, and motion ratio are known.
- [ ] Add optional wheel-load vectors and contact-patch markers where direct wheel-load/contact data exists.
- [ ] Show configured camber, toe, caster, and ride height as setup overlays; animate them only when source telemetry measures them.
- [ ] Correlate displacement split, inside-wheel droop saturation, and wheel-load transfer with ARB setup without claiming ARB causation from travel alone.

### Telemetry and retention

- [ ] Add capability bindings for shock deflection and shock velocity instead of reading game-specific channels in renderer or analysis code.
- [ ] Record iRacing `suspension.shock-defl-st`, `suspension.shock-vel`, and `suspension.shock-vel-st` channels so saved laps retain shock evidence.
- [ ] Resolve setup ride height, static shock deflection, spring perch offset, spring rate, and bump-stop range/rate where each game exposes them.

### Limit-event analysis

- [ ] Replace legacy `detectSuspensionOverload()` packet-field logic with semantic, per-game capability-aware analysis.
- [ ] Detect near compression limit, confirmed bottom-out, near droop limit, confirmed top-out, and bump-stop engagement independently per wheel.
- [ ] Detect repeated high-speed compression and rebound only when car/setup-specific velocity thresholds or damper curves provide valid limits.
- [ ] Group adjacent samples with hysteresis and minimum duration so one curb strike produces one event.
- [ ] Store wheel, start/end/peak frame, track position, speed, peak travel, peak shock velocity, evidence source, and confidence for every event.
- [ ] Use “near travel limit” when only normalized/default ranges exist; reserve “bottom-out” and “top-out” for known physical limits.

### Analyse surfaces

- [ ] Add suspension events to Analyse timeline and allow insight navigation to jump to peak frame.
- [ ] Mark event locations on track map with wheel and event type.
- [ ] Flash affected shock/bump stop in 3D playback without obscuring tire or drivetrain state.
- [ ] Add per-wheel travel and shock-velocity traces for inspecting compression/rebound around event.

### Verification

- [ ] Cover exact-limit, inferred-limit, unavailable-channel, noisy-threshold, and event-grouping behavior with per-game tests.
- [ ] Verify live and saved-lap parity before enabling iRacing shock-derived insights.
