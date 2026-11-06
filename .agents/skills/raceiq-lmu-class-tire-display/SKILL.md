---
name: raceiq-lmu-class-tire-display
description: "Use when updating LMU class-specific tire choices in RaceIQ car cards/dialogs; check authoritative class labels, distinguish availability from temperature guides, and verify via seeded cars E2E."
---

# LMU class tire display workflow

For LMU car-card tire availability changes:

- Read `packages/game-lmu-metadata/src/cars.json` for exact case-sensitive class labels. Current mappings: `HYPERCAR`, `LMP2`, `GT3`.
- Keep confirmed class dry compound mapping centralized in `packages/cars-catalogue/ui/cars/TireCompounds.tsx` (`LMU_DRY_COMPOUNDS`) and consume in `packages/cars-catalogue/ui/lmu/LMUCars.tsx` cards and dialog.
- Temperature ranges are only from `getTireTempGuide("lmu")`; filter guide rows to class compounds and never infer class availability from all guide rows.
- Show track-specific availability caveat. Unmapped classes explicitly show unknown. Do not imply wet availability unless verified.
- Extend real-API LMU E2E in `packages/cars-catalogue/test/e2e/cars.spec.ts` for each mapped class, unknown class, visible dialog rows, and browser errors.
- Verify sequentially: `bun run --cwd packages/cars-catalogue typecheck`, `bun run build`, `bun run --cwd packages/cars-catalogue test:e2e`, and `bun test test/changelog.test.ts --timeout 60000` when release notes change.

Current approved mapping: Hypercar Soft/Medium/Hard; LMP2 Soft/Medium; GT3 Medium.
