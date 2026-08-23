# Stacked Branch Strategy

This document records the branch structure for the multi-lap Compare, shared track-map, runtime imagery, and generated track-data work. It also defines how to review, push, merge, and rebase the stack without presenting every prerequisite as part of the Compare pull request.

## Why the work is stacked

The Compare feature uses shared map controls. Shared map controls use runtime imagery contracts. Runtime imagery uses the canonical track registry. Those dependencies must be available for compilation and behavioral verification, but they are separate review concerns.

A diff from the tip of the stack directly to `main` includes every ancestor. Review each branch against its immediate parent instead.

```text
origin/main
└── Korupt-virus/feat-track-registry-assets
    └── Korupt-virus/feat-track-imagery-runtime
        └── Korupt-virus/feat-track-map-canvas-controls
            └── Korupt-virus/feat-compare-multi-lap-imagery-and-map-controls
```

## Pull-request bases

Open and review branches in this order:

1. `Korupt-virus/feat-track-registry-assets`
   - Base: `main`
   - Owns canonical registry output and bundled track-data layout.
2. `Korupt-virus/feat-track-imagery-runtime`
   - Base: `Korupt-virus/feat-track-registry-assets`
   - Owns public imagery routes, runtime loading, registry access, and shared imagery contracts.
3. `Korupt-virus/feat-track-map-canvas-controls`
   - Base: `Korupt-virus/feat-track-imagery-runtime`
   - Owns reusable map canvas, pan, zoom, layers, imagery rendering, and Analyse integration.
4. `Korupt-virus/feat-compare-multi-lap-imagery-and-map-controls`
   - Base: `Korupt-virus/feat-track-map-canvas-controls`
   - Owns multi-lap selection, synchronized maps and charts, Compare layout controls, URL state, and Compare tests.

Do not open the Compare branch against `main` while its parent branches remain unmerged. That view includes every prerequisite and makes the Compare change appear much larger than its 31 feature files plus two stacking-documentation files.

## Other owner branches

The stack above intentionally excludes these concerns:

- `Korupt-virus/feat-track-imagery-registry-and-curation-workbench`: developer curation UI, import jobs, provider discovery, and developer routes.
- `Korupt-virus/feat-telemetry-semantic-normalization-and-provenance`: telemetry semantic IDs, normalization, provenance, and generated telemetry catalogs.
- `Korupt-virus/feat-iracing-enrich-catalogs-and-bundle-official-track-maps`: iRacing catalog and official map data.
- `Korupt-virus/feat-iracing-ibt-paths-and-orientation`: iRacing IBT path and orientation handling.
- `feat/103-racing-line-overlay`: Analyse racing-line visualization behavior.

Changes owned by those branches must not be copied into the Compare stack merely to make an extraction compile. Add an explicit dependency or wait for the owning branch to merge.

## Push order

Push parent branches before children so every remote pull-request base exists:

```bash
git push -u origin Korupt-virus/feat-track-registry-assets
git push -u origin Korupt-virus/feat-track-imagery-runtime
git push -u origin Korupt-virus/feat-track-map-canvas-controls
git push --force-with-lease origin Korupt-virus/feat-compare-multi-lap-imagery-and-map-controls
```

The Compare branch requires `--force-with-lease` because its local history was rebuilt. Never use an unconditional force push.

## Merge and rebase procedure

After a parent pull request merges:

1. Fetch updated `origin/main`.
2. Rebase the next branch onto `origin/main`.
3. Force-push that rebased branch with `--force-with-lease`.
4. Change its pull-request base to `main`.
5. Repeat for each remaining child.

For squash merges, always rebase the child onto the new `origin/main`; the parent commit IDs no longer exist after squashing. For merge-commit or rebase merges, still verify the child diff against `origin/main` before changing its pull-request base.

Keep a backup ref before every history rewrite. The pre-split Compare state is retained at:

```text
backup/feat-compare-multi-lap-before-split-20260823
```

## Generated asset branch size

The generated asset branch is the source of the approximately four million added lines visible from the Compare tip to `main`.

Measured incremental asset payload:

- 3,062 changed tracked asset files under `shared/data/tracks`.
- 184.4 MiB of Git blob content.
- Four `.rqi` imagery packs totaling 105.2 MiB.
- JSON metadata and geometry totaling 64.1 MiB.
- CSV geometry totaling 10.6 MiB.
- SVG geometry totaling 4.0 MiB.
- Two Spa `.rqi` packs are approximately 46 MiB each.

The line count is dominated by generated JSON geometry. The byte cost is dominated by `.rqi` imagery packs.

## Asset-storage decision

Do not merge or push the generated asset branch as ordinary source code until imagery-pack storage is resolved. The branch is a local holding branch that keeps generated data out of the runtime, map, and Compare review diffs.

Recommended production layout:

1. Keep registry metadata, checksums, source attribution, licensing, and compact lookup data in Git.
2. Publish `.rqi` imagery packs as versioned release artifacts or object-storage objects.
3. Store pack URL, version, SHA-256, size, and attribution in the registry manifest.
4. Download and cache packs during release assembly or on demand at runtime.
5. Fail closed on checksum mismatch and retain the previous valid cached version.

Git LFS is an acceptable fallback only if every development, CI, release, and source-archive workflow is configured to fetch LFS objects. Release artifacts or object storage avoid permanently adding large imagery blobs to normal Git clone history.

The remaining metadata and geometry set is still large enough that Git hosting may suppress its rendered diff. Review generated-data changes through deterministic registry checks, source hashes, file counts, and sampled semantic diffs rather than a line-by-line pull-request review.

## Verification gates

Before pushing each branch:

### Registry assets

- Registry SQLite `user_version` matches runtime contract.
- Stored registry source hash equals hash computed from checked-out source files.
- `.gitattributes` forces LF for JSON, CSV, and SVG assets and treats SQLite as binary.
- No legacy registry layout remains.

### Runtime imagery

- Typecheck passes.
- Runtime imagery contract tests pass.
- `GET /api/track-imagery/:ordinal` returns JSON instead of a registry error.

### Shared map controls

- Typecheck passes.
- Static map drawing tests pass.
- Analyse map supports pan, zoom, layers, and optional imagery without Compare imports.

### Compare

- Typecheck passes.
- Multi-lap selection, map alignment, cursor synchronization, imagery fallback, AI, URL state, and changelog tests pass.
- Incremental diff contains no developer-workbench, telemetry-catalog, or iRacing implementation paths.

## Current branch handling

The current Compare branch is correct as a stacked child: its incremental diff against the map-controls branch is 33 files, comprising 31 feature files and two documentation files. It is not suitable for a pull request against `main` until parent branches merge.

Before any remote push:

1. Resolve external storage for `.rqi` packs.
2. Update the registry-assets branch to reference external packs instead of committing them directly.
3. Rebase runtime, map-controls, and Compare branches onto the updated asset branch.
4. Re-run registry hash, runtime API, typecheck, and focused behavior checks.
5. Push branches in parent-to-child order and set pull-request bases as documented above.
