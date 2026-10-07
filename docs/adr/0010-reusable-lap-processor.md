---
status: proposed
---
# Reusable lap processor package ownership

Relocate existing capture readers and writers to `@raceiq/capture-formats` and expose existing game parser modules through direct subpath exports. Move `LapIndexPacket` into shared telemetry types. Keep implementations, adapter execution, server launch behavior, and parser state unchanged. Direct package ownership enables reuse without introducing runtime layers or backend initialization.

Plan: [Implementation requirements and verification](../plans/reusable-lap-processor.md).
