## Context

LMU car cards currently show the same three dry-compound circles for every car because `TireCompoundDots` reads game-wide temperature metadata. LMU catalog records already carry each car’s class, so the cars page can display class-appropriate dry options instead. Show available options by class and disclose track-dependent availability; do not imply the cars catalog knows selected track or event rules.

## Approach

1. Extend the LMU car-card tire display in `packages/cars-catalogue/ui/lmu/LMUCars.tsx` to use `car.class` and show class-specific options rather than game-wide `TireCompoundDots`. Reuse `CompoundCircle` from `../cars/TireCompounds`; export it if needed. Define dry options once in the LMU UI: Hypercar = Soft/Medium/Hard; LMP2 = its single dry option; GT3 = Medium. Show wet as an available tire type separately for classes where supported by the checked LMU game data. Preserve existing card click/dialog behavior.
2. Change the LMU card’s tire dialog to receive the selected car class and list only that class’s documented dry compounds. Keep temperature values sourced from `getTireTempGuide("lmu")`; do not fabricate class-specific temperature targets. Label that options can vary by track, and distinguish known class-level tire choices from unverified track-specific availability. For any LMU class not covered by verified data, show an explicit unavailable/unknown state instead of borrowing another class’s choices.
3. Verify exact current class labels and available tire choices against the latest official LMU in-game/official documentation before encoding the mapping. If official evidence does not establish a class’s available choices, keep that class unknown in the UI rather than asserting a guessed mapping. Add a focused regression to the existing cars E2E covering Hypercar, LMP2, GT3 and unknown class behavior.

## Critical files & anchors

- `packages/cars-catalogue/ui/lmu/LMUCars.tsx` — card has `car.class`; currently renders global dots and opens generic tire dialog.
- `packages/cars-catalogue/ui/cars/TireCompounds.tsx` — existing compound circles and guide-based temperature dialog.
- `packages/game-lmu-metadata/src/cars.json` — authoritative app class values, e.g. `GT3`.
- `packages/cars-catalogue/test/e2e/cars.spec.ts` — existing cars browser E2E.

## Verification

- Run focused cars E2E through existing compiled application and seeded catalog. For one car per class, open LMU cars page and observe card/dialog: Hypercar lists only its documented dry options; LMP2 and GT3 do not show Soft/Medium/Hard as universal choices; unknown class shows no guessed options; temperature rows remain source-backed. Check visible track-variation note and no browser errors.
- Run the cars-catalogue package typecheck and relevant E2E after production build. Record exact commands and outcomes in completion report.

## Assumptions & contingencies

- Default scope is catalog presentation, not changing tire-temperature data, strategy algorithms, or race-event tire rules.
- The previous research indicates Hypercar choices include Soft/Medium/Hard, LMP2 has one dry compound, and GT3 uses Medium; track availability can vary. Confirm exact labels and wet availability from current official evidence before implementation. If mapping is not fully supported, render only verified facts and unknown states.