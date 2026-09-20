# Remove `You are` Audio Breath Artifact

## Problem

The isolated `You are` audio used by opponent pace announcements begins with an unwanted breath/sigh. Both `phrase.within-class-pace` and `phrase.off-class-pace` point to byte-identical generated audio, so the artifact is in the shared recording rather than caused by clip batching or playback sequencing.

## Design

Remove the OmniVoice phoneme override `You [AA1 R]` for both affected phrase IDs. Generate them from plain source text `You are`, retaining existing voice, speed, seed, and normalization settings unless regeneration demonstrates a separate synthesis issue. Keep the two catalog entries as independent clips; runtime sentence assembly remains unchanged.

Update generated FLAC files, manifest hashes/durations/content hashes, and the generated TypeScript catalog. Add source-level regression coverage asserting the affected synthesis text resolves to plain `You are`, preventing reintroduction of the phoneme override.

## Verification

- Run focused generator/catalog tests.
- Regenerate affected clips with the project audio generation command.
- Confirm both affected files have valid manifest hashes and are no longer byte-identical only if synthesis naturally differs; identical content is acceptable if both cleanly pronounce `You are`.
- Play the isolated `phrase.within-class-pace` segment and confirm no leading breath/sigh.
