# Unlimited lap-analysis sectors

## Status
Implemented arbitrary-sector prompt support. Native timelines now pass every native time and sector start boundary unchanged. Curated non-native layouts retain 3-sector output with starts `[0, s1End, s2End]`.

## Changes
- Replaced fixed `{s1, s2, s3, s1End, s2End}` prompt contract with `PromptSectors { times: number[]; sectorStarts: number[] }`.
- Prompt sector lines, corner coverage labels, and boundary formatting iterate arbitrary sector counts.
- Generation passes native timeline arrays directly and preserves curated 3-sector behavior.
- Added 6-sector prompt and generation coverage while retaining 3-sector assertions.

## Verification
- `bun test test/ai-track-context.test.ts test/generate-lap-analysis.test.ts test/iracing-sector-layout.test.ts --timeout 30000` — 21 pass, 0 fail.
- `bun test test/lap-analysis-route.test.ts test/lap-analysis-tool.test.ts test/lap-analysis-generation-tool.test.ts test/generate-lap-analysis.test.ts --timeout 30000` — 15 pass, 0 fail.
- `git diff --check -- server/ai/analyst-prompt.ts server/ai/generate-lap-analysis.ts test/ai-track-context.test.ts test/generate-lap-analysis.test.ts` — clean.

## Concerns
No known concerns. Native sector starts intentionally represent source starts; final sector ends at lap end and is not invented as an extra native boundary.
