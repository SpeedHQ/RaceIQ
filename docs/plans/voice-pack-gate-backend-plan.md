# Voice-pack gate backend plan

Contract: [shared voice-pack gate](voice-pack-gate-contract.md). UI can proceed independently using shared response fixture; real integration required before completion. Backend owns shared descriptor, manifest metadata and production endpoint.

## Scope and tasks

Own package dependency composition/export, shared catalog-version JSON/wire constant, status route, manifest/generator metadata, tooling version enforcement and regression coverage. Catalog and pack versions have separate authoritative JSON sources, consumed by TypeScript and Python without duplicate constants. No remote version lookup or automatic installer.

1. Declare independent catalog compatibility 1.0.0 in shared catalog-version JSON. Compose it with engineVersion 1, language en and packageVersion 1.0.0 from package descriptor. Derive immutable locale/version ZIP URL; no latest-version lookup.
2. Add engineVersion, packageVersion and language to generated/source manifest. Python generator consumes same JSON descriptor. Build/install reject different/unversioned/incompatible packs while retaining old installation on failure. Separate manual voice-pack release workflow refuses overwriting existing version/tag; app releases no longer republish packs.
3. GET endpoint reads writable installed path; absent manifest -> download-required; invalid/unversioned/unsupported engine or package version/locale/catalog or missing referenced asset -> update-required; exact supported metadata + complete safe manifest -> ready. Unexpected filesystem failures surface error, not missing. Use no-store response and existing auth.
4. Register focused behavioral tests within existing owner manifests without moving unrelated entries. Update pack instructions and independent version bump/release process; keep future language selection out of scope.

## Acceptance and edge handling

B1/G1: absent installed manifest; no bundled fallback. B2/G2: old/new engine or package versions, unsupported locale, unversioned/corrupt manifest, incompatible catalog, unsafe/missing referenced files produce update-required without leaking arbitrary files. B3/G3: matching compatible real complete pack ready; recheck reflects replacement. B4/G4: unexpected I/O error returns failure; UI can retry. B5/G5: one supported engine version and pinned English dependency consumed by build/install/status/client contract; immutable independently versioned ZIP remains separate release artifact.

B6/G6: generator, manifest, wire producer, installer and status reader use authoritative semantic catalog version; model labels/future versions are rejected. Shared E5 is mandatory integration evidence alongside E1–E4.

## Verification

Execute shared E1–E5 with real backend HTTP and browser Radio UI. Supplement with isolated filesystem/route checks for incompatible metadata and incomplete files. Use production pack build/install in E3 and canonical wire-line helper in E5; mismatched installer input must preserve prior pack. Parent owns final integration execution and records outcomes in shared contract; planned tests are not evidence.
