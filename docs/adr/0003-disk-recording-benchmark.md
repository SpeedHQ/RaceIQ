# Measure production disk-backed imports separately

Status: proposed

Plan: [Disk-backed import benchmark](../plans/disk-recording-benchmark.md).

## Context

Memory-only imports exclude database and capture writes. The user clarified that disk import is the required workload, not live recording or UDP replay.

## Decision

Replace the added recording mode with disk-backed imports through the production import route, using real capture storage and SQLite. Time fixture reads through completed import persistence/finalisation; exclude setup, validation, and engine teardown. Use the Rust release recorder explicitly. Allow a storage root to select the filesystem.

## Rationale

A synthetic file-write loop omits parsing, sparse encoding, lap derivation, persistence, and finalisation. The production import route retains those costs and artifact ownership semantics for both engines without requiring acquisition hardware or replay pacing. Warm filesystem cache remains enabled; capture size is not device traffic or durability proof. Existing memory-only and live benchmarks remain unchanged.
