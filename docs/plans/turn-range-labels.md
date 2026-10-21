# Fix duplicated turn-range labels

ADR: [Shared turn-token recognition](../adr/0002-turn-range-labels.md)

## Requirements

- Fix reviewed P2: Analyse renders synthesized `T1-2`/`T3-4` names twice.
- Fix shared formatter so track-detail and prompt consumers benefit too.
- Preserve genuine corner names, official numbering, and lap-boundary grouping.
- No compare-page or experiments refactor; preserve segment times.
- Commit and push verified fix to existing upstream branch, preserving remote changes.

## Implementation and acceptance

1. Add regression coverage for multi-turn placeholder names and real named corners.
2. Extend existing shared auto-turn token matcher to recognize numeric ranges/lists used by segment producers.
3. Verify regression fails before and passes after; exercise real Homestead segments through Analyse and shared labels.
4. Update Unreleased fix note and run repository changelog validation.
5. Commit intended files, integrate any upstream additions without rewriting history, and push.
