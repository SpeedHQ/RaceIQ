---
status: proposed
---
# Recognize synthesized turn ranges in shared labels

## Problem

Segment joining synthesizes unnamed multi-turn names such as `T1-2`, but shared label formatting recognizes only single-number placeholders. Analyse's new shared formatter call therefore duplicates turn ranges.

## Decision

Extend existing shared auto-turn token matcher to recognize numeric ranges and lists. Keep official number/covers metadata authoritative and preserve real names. Avoid an Analyse-only workaround, which would leave track-detail and prompt formatting inconsistent.

Plan: [Fix duplicated turn-range labels](../plans/turn-range-labels.md)
