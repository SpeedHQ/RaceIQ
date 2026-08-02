# Track Meta Migration Plan

Fix track meta duplication. Two distinct problems, one migration.

## Problem

### 1. Same circuit split across two roster files

Meta files are already multi-game (`brands-hatch.json` carries `games: acc, fm-2023, ac-evo`).
But where two games named the same layout differently, it got two files instead of one.

| files | games | evidence |
|---|---|---|
| `brands-hatch-s` + `brands-hatch-indy` | fm-2023 / ac-evo | Forza "Tor Indy" 1.93km = ac-evo "Indy". Forza has real corner names, ac-evo has `T1..T5` |
| `austin` + `cota` | f1-2025,acc / ac-evo | "Circuit of the Americas" vs "Circuit Of The Americas". Both placeholders. 21 vs 18 segs |
| `nordschleife` + `nurburgring-nord` | acc,ac-evo / fm-2023 | **UNCONFIRMED** — see Step 1 |

Cost: corner names authored once are invisible to the other game. `brands-hatch-s` has
Paddock Hill Bend / Druids / Graham Hill Bend / Surtees / Clearways; `brands-hatch-indy` is
the same tarmac showing `T1..T5`.

### 2. Layout identity is not modelled

Slug suffixes carry layout meaning but are per-game shorthand and not derivable:

`-s` = National (Catalunya, Silverstone, Hockenheim), Club (Grand Oak, Hakone, Road Atlanta),
Short (Laguna Seca, Mid-Ohio, Maple Valley), East (Suzuka), South (VIR), **Indy** (Brands Hatch).

Forza's `tracks.csv` `variant` column is the only source of real layout names.

### Non-goal: shared corner pool

Rejected. A corner entry carries `frac` along the lap. Brands Hatch Indy is ~1.93km vs GP
~3.70km, so Paddock Hill Bend sits at a different `frac` in each. Sharing corner records
across layouts would require stripping `frac`, which guts the record. Rosters stay
self-contained per layout. Layouts are related by the `track` field only — no runtime
cross-file reads.

## Schema change

Every roster gains three fields:

```jsonc
{
  "slug": "brands-hatch-indy",
  "track": "brands-hatch",     // physical venue, groups layouts
  "layout": "indy",            // real layout id, from Forza variant column
  "layoutName": "Indy",        // display; renders as "<name> — <layoutName>"
  "name": "Brands Hatch",      // venue name, identical across layouts
  ...
}
```

Geometry sidecars keep slug-based paths (`shared/tracks/<gameId>/<slug>-segments.json`),
matching existing `<slug>-centerline.csv` / `<slug>-boundaries.json` convention.

## Layout map (from fm-2023 `tracks.csv` `variant` column)

| slug | layout | layoutName |
|---|---|---|
| `brands-hatch` | `gp` | Grand Prix |
| `brands-hatch-s` | `indy` | Indy |
| `catalunya` | `gp` | Grand Prix |
| `catalunya-s` | `national` | National |
| `catalunya-s2` | `national-alt` | National Alt |
| `daytona` | `sports-car` | Sports Car |
| `daytona-oval` | `oval` | Tri-Oval |
| `eaglerock` | `club` | Club |
| `eaglerock-oval` | `oval` | Oval |
| `eaglerock-r` | `club-reverse` | Club Reverse |
| `fujimi-kaido` | `full` | Full |
| `fujimi-kaido-r` | `full-reverse` | Full Reverse |
| `grand-oak` | `national` | National |
| `grand-oak-r` | `national-reverse` | National Reverse |
| `grand-oak-s` | `club` | Club |
| `hakone` | `gp` | Grand Prix |
| `hakone-s` | `club` | Club |
| `hakone-sr` | `club-reverse` | Club Reverse |
| `hockenheim` | `full` | Full |
| `hockenheim-s` | `national` | National |
| `hockenheim-s2` | `short` | Short |
| `homestead` | `road` | Road |
| `homestead-oval` | `speedway` | Speedway |
| `indianapolis` | `gp` | Grand Prix |
| `indianapolis-oval` | `oval` | The Brickyard Speedway |
| `kyalami` | `gp` | Grand Prix |
| `laguna-seca` | `full` | Full |
| `laguna-seca-s` | `short` | Short |
| `le-mans` | `full` | Full |
| `le-mans-old` | `old-mulsanne` | Old Mulsanne |
| `lime-rock` | `full` | Full |
| `lime-rock-alt` | `full-alt` | Full Alt |
| `lime-rock-sc` | `south-chicane` | South Chicane |
| `maple-valley` | `full` | Full |
| `maple-valley-s` | `short` | Short |
| `maple-valley-sr` | `short-reverse` | Short Reverse |
| `mid-ohio` | `full` | Full |
| `mid-ohio-s` | `short` | Short |
| `mount-panorama` | `full` | Circuit |
| `mugello` | `full` | Full |
| `mugello-s` | `club` | Club |
| `nurburgring` | `gp` | GP |
| `nurburgring-full` | `full` | Full (GP + Nordschleife) |
| `nurburgring-nord` | `nordschleife` | Nordschleife |
| `nurburgring-s` | `sprint` | Sprint |
| `road-america` | `full` | Full |
| `road-america-s` | `east` | East Route |
| `road-atlanta` | `full` | Full |
| `road-atlanta-s` | `club` | Club |
| `sebring` | `full` | Full |
| `sebring-s` | `short` | Short |
| `silverstone` | `gp` | Grand Prix |
| `silverstone-s` | `national` | National |
| `silverstone-s2` | `international` | International |
| `spa` | `full` | Full |
| `sunset-peninsula` | `full` | Full |
| `sunset-peninsula-oval` | `speedway` | Speedway |
| `sunset-peninsula-r` | `full-reverse` | Full Reverse |
| `sunset-peninsula-s` | `club` | Club |
| `sunset-peninsula-sr` | `club-reverse` | Club Reverse |
| `suzuka` | `full` | Full |
| `suzuka-s` | `east` | East |
| `vir` | `full` | Full |
| `vir-ge` | `grand-east` | Grand East |
| `vir-gw` | `grand-west` | Grand West |
| `vir-n` | `north` | North |
| `vir-s` | `south` | South |
| `watkins-glen` | `full` | Full |
| `watkins-glen-s` | `short` | Short |
| `yas-marina` | `full` | Full |
| `yas-marina-n` | `north` | North |
| `yas-marina-nc` | `north-corkscrew` | North Corkscrew |
| `yas-marina-s` | `south` | South |

Other games carry no variant data worth mining: acc is `GP` on all 36 rows except `24h`;
ac-evo the same plus one `Indy`; f1-2025 all `Grand Prix` plus 4 `Short` rows.

`Brand Hatch` typo and `Tor` (Polish for "circuit") are Forza's own data. `layoutName`
above uses corrected English.

## Steps

- [ ] **1. Verify nordschleife pairing.** Compare centerline arc length of `nordschleife`
      against `nurburgring-full` (25.38km) and `nurburgring-nord` (20.83km). `nordschleife.json`
      says "24h layout", 76 segs, real German names (Castrol-S, Dunlop-Kehre,
      Michael-Schumacher-S); ACC calls it "Nurburgring 24h". Forza's 24h equivalent is
      `nurburgring-full` (Nordschleife + GP loop), not `-nord`. 76 vs 65 segs is consistent
      with the extra GP loop. Read-only. Decides which merge runs in Step 3.
- [ ] **2. Tag all 102 rosters** with `track` / `layout` / `layoutName` per the map above.
      Non-variant tracks get `layout: "gp"` or `"full"` per their own CSV variant. Dry-run first.
- [ ] **3. Merge confirmed duplicates.** Union `games`, keep named corners over placeholders.
      `brands-hatch-indy` inherits Paddock Hill Bend / Druids / Graham Hill Bend /
      Cooper Straight / Surtees / Clearways from `brands-hatch-s`. Surviving slug is the
      layout-explicit one (`brands-hatch-indy`; `cota` folds into `austin`). Nordschleife pair
      only if Step 1 confirms. Dry-run first.
- [ ] **4. Rename 23 primaries** to layout-explicit slugs (`brands-hatch` → `brands-hatch-gp`).
      Only the 23 bases that actually have sibling variants — the other 79 rosters keep their
      slugs, no churn. Update `tracks.csv` in all 4 games, geometry sidecars including Forza's
      ordinal-suffixed `brands-hatch-860-centerline.csv`, and `shared/tracks/corner-names/`.
      Dry-run first.
- [ ] **5. Fix names.** `Brand Hatch` → `Brands Hatch`; `brands-hatch-s` raw slug leaked into
      `name`; move `— National` / `— Historic` suffixes out of `name` into `layoutName` so
      `name` is plain `Circuit de Barcelona-Catalunya` on all three Catalunya rosters.
- [ ] **6. Validate.** Every roster resolves; no duplicate `(track, layout)` pair; every
      `tracks.csv` slug resolves to a roster; every geometry sidecar path still resolves.

## Out of scope

- 3 Forza slugs with no meta file: `daytona-oval`, `fujimi-kaido-r`, `suzuka-s`.
- 9 f1-2025 rows with empty slug: Paul Ricard, Hockenheim, Sochi, Hanoi, Portimao, and the
  4 `Short` layouts (Sakhir, Silverstone, Austin, Suzuka). f1-2025 Silverstone Short is
  3.660km — matches neither `silverstone-s` (2.64km) nor `silverstone-s2` (2.98km), so it is
  a distinct layout needing its own roster, not a mapping.
