# Remove `You are` Audio Breath Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regenerate opponent-pace `You are` clips without the leading breath artifact.

**Architecture:** Remove the special OmniVoice phoneme text override for both affected phrase IDs. Keep runtime segment batching and playback unchanged. Regeneration updates FLAC assets and generated catalog metadata.

**Tech Stack:** Python audio generator, OmniVoice, FLAC assets, Bun tests, TypeScript generated catalog.

## Global Constraints

- Preserve existing voice, speed, seed, sample rate, trimming, and join settings.
- Keep `phrase.within-class-pace` and `phrase.off-class-pace` as separate clips.
- Do not alter runtime sentence assembly.
- Verify isolated phrase playback, not only source text.

---

### Task 1: Lock synthesis input and regenerate assets

**Files:**
- Modify: `scripts/live-engineer/generate.py:35-38`
- Modify: `client/public/audio/live-engineer/v1/phrase__within-class-pace.flac`
- Modify: `client/public/audio/live-engineer/v1/phrase__off-class-pace.flac`
- Modify: `client/public/audio/live-engineer/v1/manifest.json`
- Modify: `shared/racing/live/engineer-audio-catalog.generated.ts`

**Interfaces:**
- Produces plain synthesis input `You are` for both affected IDs.
- Produces regenerated assets whose SHA-256 values match manifest and catalog metadata.

- [ ] Remove `phrase.within-class-pace` and `phrase.off-class-pace` entries from `SYNTHESIS_TEXT_OVERRIDES`, allowing `model.generate()` to use `PHRASES` text.
- [ ] Run the generator in single-segment force mode for each affected phrase using the existing reference voice and validation options; retain generated manifest/catalog output.
- [ ] Confirm manifest `spokenText` remains `You are`, generated files are valid FLAC, and recorded hashes match files.

### Task 2: Add focused source regression coverage

**Files:**
- Modify: `test/live-engineer-generator.test.ts` if existing generator tests are present; otherwise create `test/live-engineer-generator.test.ts`.
- Modify: `scripts/live-engineer/generate.py` only if a small importable helper is needed.

**Interfaces:**
- Test asserts both affected phrase IDs resolve to exact synthesis text `You are` and do not use bracket phoneme notation.

- [ ] Inspect existing generator test conventions and add a focused assertion against the exported or test-visible synthesis mapping.
- [ ] Run the focused generator test and confirm it passes.

### Task 3: Verify isolated playback and catalog integrity

**Files:**
- Read: `client/src/lib/live-engineer-audio.ts`
- Read: `shared/racing/live/engineer-audio-catalog.generated.ts`
- Read: `client/public/audio/live-engineer/v1/manifest.json`

**Interfaces:**
- Verifies one-segment playback path has no neighbor overlap and affected asset hashes validate.

- [ ] Run the project’s focused audio/catalog checks.
- [ ] Launch the actual dev surface or use its existing audio smoke path to play only `phrase.within-class-pace`.
- [ ] Confirm no leading breath/sigh is audible; if runtime playback is unavailable, report the exact unavailable prerequisite rather than claiming audio success.
