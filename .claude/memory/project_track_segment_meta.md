---
name: track-segment-meta-architecture
description: venue/revision/layout source hierarchy, shared facts, per-game geometry, and runtime projection
type: project
---

Canonical source hierarchy:

```text
shared/data/tracks/venues/<root>/venue.json
shared/data/tracks/venues/<root>/revisions/<revision-path>/revision.json
shared/data/tracks/venues/<root>/revisions/<revision-path>/tracks/<layout>/metadata.json
```

`current` is source-only default revision. Current canonical layout ID remains
`<root>/<layout>`. Historical ID is `<root>/<revision-path>/<layout>`; nested
revision paths are valid. Never use layout/revision order. Historical revision
documents reconstruct nested venue nodes; current does not project revision node.

Layout metadata owns assignments plus optional game-agnostic `facts`,
game-keyed `geometryByGame`, and verification. Game assets are layout-local:

```text
revisions/<revision-path>/tracks/<layout>/geometry/<gameId>/{centerline.csv,raceline.csv,boundaries.json}
```

Revision imagery belongs under revision directory. Guide and detector hints stay
under layout. ACC 2019 shared geometry and TUMFTM baselines remain at root venue
`geometry/acc/` and `geometry/tumftm/`. AC Evo has five explicit ACC fallbacks:
Misano, Silverstone, Catalunya, Budapest, and Zandvoort.

**Access through modules, never direct guessed paths:**
- `shared/racing/tracks/storage/meta.ts` — facts, per-game fractional geometry,
  labelled segments, sectors, authoring.
- `shared/racing/tracks/storage/assets.ts` — registry identity and canonical
  exact/shared raw-asset paths.
- `shared/racing/tracks/resolve-name.ts` — display/catalog names and bundled
  point loading.

Corner keys use official turn numbers (`t3`, `t10-11`); straight keys use the
preceding corner (`s3`). Placeholder `T3` labels are display-only and must not
be stored as facts.

Track-local authored siblings:
- `guide.json` — prose and coaching; future locales use `guide.<locale>.json`.
- `detect-hints.json` — source-only curvature-detector allowances.
- `geometry/<gameId>/` — shippable game geometry.

Runtime ships generated `registry.sqlite`, revision imagery, layout geometry, and
guides. It excludes `venue.json`, `revision.json`, `metadata.json`,
`detect-hints.json`, registry source, and report. All game-scoped APIs require
`gameId`; never default one.
