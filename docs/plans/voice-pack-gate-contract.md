# Versioned voice-pack gate contract

Implementation plans: [UI](voice-pack-gate-ui-plan.md), [backend](voice-pack-gate-backend-plan.md).

## Agreed boundary

User requires hardcoded compatibility versions, not checksums or remote version negotiation. `shared/racing/live/audio-catalog-version.json` owns independent semantic catalog version `1.0.0`; `qwen-v3` remains only the voice-generation/storage identity. `packages/live-engineer/audio-package.json` owns engine compatibility version `1`, English locale `en` and package revision `1.0.0`. TypeScript composes both sources in `@raceiq/live-engineer/audio-package`; Python generation consumes both JSON files. Manifest declares catalogVersion, engineVersion, packageVersion and language. Voice-line messages and browser playback consume the same catalog version. Dependency URL is `https://github.com/SpeedHQ/RaceIQ/releases/download/voice-pack-en-v1.0.0/live-engineer-qwen-v3-en-1.0.0.zip`. Existing unversioned or model-label catalogs require update. Voice-pack releases are independently versioned and immutable; locale filenames/tags prevent future language collisions. Language selection remains out of scope.

`GET /api/live-engineer/voice-pack` uses existing app authentication and returns HTTP 200 JSON:

```json
{"state":"download-required","requiredVersion":"1.0.0","installedVersion":null,"requiredEngineVersion":1,"installedEngineVersion":null,"language":"en","downloadUrl":"https://github.com/SpeedHQ/RaceIQ/releases/download/voice-pack-en-v1.0.0/live-engineer-qwen-v3-en-1.0.0.zip"}
```

`state`: `download-required` (manifest absent), `update-required` (invalid or unsupported contract/revision or incomplete files), or `ready`. Hardcoded engine/catalog/locale are exact compatibility requirements; requiredVersion is the minimum supported recording revision. Compatible newer revisions remain ready and may be offered by trusted release discovery. Installed fields report readable values or null. GET uses no-store and never performs remote discovery. Automatic checks require release flag plus enabled user audio; explicit manual management is opt-in. See [package management contract](wizard-live-engineer-package-contract.md) for enriched status fields, install/update operations, trusted metadata and prompt rules.

## Observable acceptance

- G1 Missing pack: Radio is accessible before telemetry/game connection and shows Download required, external download link, install guidance and Check again. Voice controls and playback blocked; text control available.
- G2 Unsupported engine/catalog/locale, below-minimum or malformed package revision, invalid manifest or missing referenced clip: Radio shows Update required. Compatible newer revisions remain playable; saved switches stay unchanged.
- G3 Matching complete pack: status ready, voice controls available and existing settings/playback semantics preserved. Check again transitions blocked to ready without reload.
- G4 Status pending/failure: voice remains blocked, loading/error shown with retry; no false download/update claim. In-flight playback cancelled when readiness lost; queued lines resolve with existing delivery failure reasons instead of waiting forever.
- G5 Engine/catalog/locale requirements and minimum English pack revision are hardcoded once; generator, installer, server and client share them. Trusted newer compatible recording revisions may update independently. Locale/version release identities remain immutable and outside app distribution.
- G6 Catalog compatibility has its own version, shared by generation, manifest, wire messages, installer, status gate and player. Legacy model labels and different catalog versions fail closed; mismatched voice lines fail with catalog-mismatch before audio starts and release their delivery.

## Shared E2E scenarios (parent verification owner)

Use isolated DATA_DIR and real backend HTTP listener plus built app; reuse existing browser harness and production Radio surface. No mocked status endpoint.

- E1/G1: no installed manifest and no connected simulator; open live dashboard then Radio; observe download gate, disabled voice switches, usable text switch and download link.
- E2/G2: install fixture pack with old/new package or engine version, unsupported language, unversioned/invalid manifest, and missing clip in turn; Check again; observe Update required, exact required version and blocked voices.
- E3/G3/G5: install real matching external ZIP via production installer; Check again; observe ready/enabled controls; verify endpoint requiredVersion equals hardcoded descriptor.
- E4/G4: delay the real status request, then trigger a real server filesystem I/O failure (or interrupt backend transport); observe checking/error/retry and blocked voices, not ready. Repair the dependency and Check again recovers. Exercise readiness loss during real WebSocket audio playback and inspect failed delivery/queue advancement.
- E5/G6: build/install current catalog 1.0.0 through production pack entry points. Serve legacy/future catalog manifests through the real status endpoint and observe update-required. Deliver a future-catalog line through real WebSocket transport; observe failed/catalog-mismatch with no started status, followed by successful canonical-catalog playback.

Record executed outcomes; unexecuted or environment-blocked scenarios are not passing evidence. Native/human listening and GitHub release publication remain outside this change.

## Executed verification

2026-10-22, isolated application DATA_DIR, real HTTP listener/Hono app, built production UI and real WebSocket deliveries:

- E1/G1 passed before simulator connection: missing pack displayed Download required, exact locale/version URL and no-store response; voice switches disabled, text control available.
- E2/G2 passed: old/new pack revisions, unversioned/corrupt manifest, old/new engine versions, unsupported French locale, incompatible catalog and missing referenced clip displayed Update required. Saved enabled voice preferences remained unchanged; text preference was independently saved.
- E3/G3/G5 passed: built `live-engineer-qwen-v3-en-1.0.0.zip`, installed through production CLI, used Check again without reload, observed ready/enabled voice controls and HTTP 200 FLAC. Exact dependency was engine 1, pack 1.0.0, language en.
- E4/G4 passed: delayed real fetch showed checking/blocked voices with usable text; real filesystem I/O failure returned error/retry rather than false missing/ready. Live WebSocket speech reported started, then failed/asset-missing when readiness was lost, with no stale completed event. Recovery delivered a new line through started/completed; another blocked line failed without started.
- Focused backend/installer/release-note tests: 24 passed; package suites: 90 passed; browser playback regressions: 7 passed. Typechecks passed for package, tooling, backend and client. All 430 ordinary tests have exactly one suite owner.
- Voice generator spec/catalog checks passed: 1,020 clips and 21 full lines. Production Vite bundle built using freshly compiled translations; temporary config skipped only the repository Paraglide atomic-rename wrapper because Windows had previously returned EPERM. Workflow YAML and app-release tag/version isolation checks passed.

GitHub publication and human/native audio listening were not executed. Publish the independent `voice-pack-en-v1.0.0` release before distributing an app that requires it.


Catalog cutover verification: E5/G6 passed through real app HTTP, browser and WebSocket transport. Legacy `live-engineer-qwen-v3` and future `2.0.0` manifest catalogs showed Update required; restoring `1.0.0` enabled voice without reload. Future-catalog delivery emitted failed/catalog-mismatch with no started event; canonical helper emitted catalog 1.0.0 and playback completed normally. Updated focused gates passed 123 tests (90 package, 25 backend/tooling/release, 8 playback), typechecks, generator spec/catalog checks and production bundle. The external ZIP was rebuilt with catalog 1.0.0.


Push gate verification: the standard commit wrapper encountered Windows EPERM while atomically renaming generated Paraglide output. Fresh translations were compiled directly. All 50 workspace typecheck/unit/tooling tasks passed via `RACEIQ_FEATURE_IRACING_ADAPTER=true bunx turbo run typecheck test:unit test:tooling --affected --only --env-mode=loose`; enabling that test adapter resolves five all-adapter analysis tests whose default release registration excludes iRacing. Production flags were not changed. Hook locale keys, lint, shard ownership and telemetry catalog checks also passed. The affected wrapper jobs are excluded only for this commit invocation; shared hook configuration is unchanged.

