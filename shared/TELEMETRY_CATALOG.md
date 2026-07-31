# Telemetry catalog

`telemetry-catalog.generated.json` is RaceIQ's central telemetry-first catalog.
It starts from semantic values, then links each supported game's source values
as `direct`, `derived`, `simplified`, or `unavailable`.

Each semantic value includes:

- hierarchy and display label
- canonical unit
- mini description
- normalized `TelemetryPacket` fields, when present
- mapping, source channels, native unit, freshness, and normalization for every game
- freshness distinguishes continuous telemetry, pit snapshots, session-info updates, and static metadata
- raw source data type and element count when source schema provides them

Semantic IDs never contain simulator names. A value can currently have only an
iRacing source while retaining a future-facing shared identity such as
`engine.oil-level`; other games can attach sources later without renaming
concept or migrating consumers.

Semantic IDs also avoid simulator source-layout containers such as
`WeekendInfo`, `DriverInfo`, `SessionInfo`, and `MotionEx`. Those names remain
on source rows while central values use reusable concepts such as
`identity.track.altitude`, `race.competitor.rating`, and
`engine.shift-light.shift-rpm`.

Source inventories cover every normalized parser output, every game-specific
extension field, every ACC/AC Evo setup-schema field, every variable in
captured iRacing SDK table, and every known core iRacing SessionInfo YAML leaf.
Every source row points back to semantic value.

`retention` distinguishes exact values from values retained only after
normalization and values not currently recorded:

- `exact` - value is retained in RaceIQ packet/source data
- `normalized` - YAML value contributes to smaller retained session summary
- `not-recorded` - value is catalogued but current capture format omits it

iRacing source-frame v2 does not preserve complete raw YAML. Issue #200 tracks
that recorder work. Catalog maps 259 known stable iRacing `CarSetup` leaf-path
variants into shared setup concepts. `CarSetup.**` remains one explicit
unmapped-remainder source because exact extra leaves vary by car and iRacing
build.

## Detailed-to-simple hierarchy

Tire temperature:

```text
Tire temperature
|-- Representative / average
|-- Carcass temperature
|   |-- Average
|   |-- Left
|   |-- Middle
|   `-- Right
`-- Surface temperature
    |-- Inner
    |-- Middle
    `-- Outer
```

iRacing representative tire temperature is simplified from three retained
carcass bands. Detailed bands remain separate packet and storage fields.

Normalized packet compatibility fields do not become fake central concepts.
Legacy `SurfaceRumble*_2` fields link to `tires.surface-rumble`, while legacy
`TireSlipCombinedFL_2` links to Forza's normalized slip-angle signal. Forza's
normalized lateral-slip scale remains separate from physical slip angle in
radians exposed by F1, ACC, and AC Evo; no unsupported conversion is implied.

Sector timing:

```text
Sector timing
|-- Sector layout
|   |-- Sector indexes
|   `-- Sector start fractions
|-- Current sector index / running time
|-- Current lap sectors
|   |-- S1 / S2 / S3 projections
|   `-- Variable-length times array
|-- Last lap sectors
|   |-- S1 / S2 / S3 projections
|   `-- Variable-length times array
|-- Per-lap sector history
`-- Best sector times
```

F1 supplies native three-sector times through LapData and SessionHistory, but
does not provide sector boundary distances. ACC supplies native current-sector
index and last completed sector time in milliseconds. iRacing YAML supplies a
variable-length `SplitTimeInfo` boundary layout, so RaceIQ derives times by
combining those fractions with lap-distance and lap-time telemetry. Forza and
AC Evo use curated track boundaries.

Car setup:

```text
Car setup
|-- Metadata
|-- Tires
|-- Alignment and steering
|-- Suspension
|-- Dampers
|-- Aerodynamics
|-- Brakes
|-- Electronics
|-- Drivetrain
|-- Strategy
`-- Weight distribution
```

Stable setup concepts link F1 packet setup, ACC/AC Evo setup-file schemas, and
iRacing YAML. Source fidelity stays explicit: for example, iRacing exposes
per-wheel camber with embedded units, F1 exposes one value per axle, and
ACC/AC Evo store car-specific clicks. Those map to one camber concept as
derived or simplified sources without discarding native paths.

Detailed setup structures remain nested instead of being collapsed:

```text
Suspension
|-- Front anti-roll bar
|   |-- Setting
|   |-- Arms
|   |-- Blades
|   |-- Diameter
|   `-- Outer diameter
`-- Rear anti-roll bar
    `-- same detailed leaves

Aerodynamics
`-- Rear wing
    |-- Setting
    `-- Angle
```

Common fuel values follow same rule. Legacy `TelemetryPacket.Fuel` remains
catalogued with its game-native unit, while `fuel.remaining-volume` and
`fuel.fuel-percent` provide comparable projections where source data permits.
Reserved parser fields populated with constants remain in source inventory but
their game mapping is `parser-placeholder`, not falsely `direct`.

## Regeneration

```bash
bun run telemetry:catalog
```

Generator reads `shared/types.ts`, all registered parser implementations,
`shared/setup-schema.ts`, `shared/telemetry-setup-catalog.ts`,
`shared/games/iracing/session-info-catalog.ts`, and
`data/diagnostics/iracing-all-vars-2026-07-29T02-06-39-162Z.json`. Catalog tests
compare generated result against committed artifact and fail when coverage,
mappings, units, descriptions, or semantic relationships drift.
