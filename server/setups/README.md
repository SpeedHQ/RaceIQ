# Setups

## Purpose

Provides guarded setup-file access, file/snapshot persistence adapters, deterministic setup mutation, and persisted applied-change summaries for Setup Engineer flows.

## Structure

- `file-guard.ts` discovers game-owned setup roots, enforces real-path containment and supported extensions, retries file reads, and parses JSON or binary AC EVO setups.
- `io.ts` reads active file or snapshot setups and writes JSON, byte-patched `.carsetup`, or advisory snapshot results.
- `rules/catalog.ts` defines supported component names, storage paths, step sizes, and hard ranges, including extracted per-car AC EVO ranges.
- `rules/engine.ts` inspects knobs and applies ordered intents to a clone.
- `applied-change-markdown.ts` renders the persisted apply summary.

## Boundaries and invariants

Game adapters own setup locations, and game codecs own binary interpretation. This domain guards and consumes those contracts but does not define game policy, session lineage, database persistence, or HTTP behavior.

Resolved file paths must remain inside the selected game setup root after symlink resolution. Rule application preserves intent order, validates every path before changing a multi-path knob, uses catalog step sizes, rounds integer knobs, clamps to hard ranges, and records applied and skipped results in input order. Binary writes patch original bytes and fall back to an advisory snapshot on failure; JSON and persisted markdown shapes remain stable.

## Testing

Setup rules are covered by Setup Engineer and F1 rule tests. Guarded binary parsing and byte-patched writes are covered by AC EVO car-setup knob/writer tests. Setup placement and format tests cover path sanitization, extension policy, and binary byte fidelity.
