# Pipeline report

Implemented canonical packet source handling across live/import pipeline and MoTeC archive representation.

- Added PacketSourceReference raw packet offsets while preserving native Buffer recording.
- Added ImportSourceRecorder and importSessionPackets with packet-index offsets.
- Added manifest-aware MoTeC archive encoding and discriminated packet/capture loader.
- Updated MoTeC import orchestration to target.convert and canonical packet ingestion.

Replay/reprocess and export boundary integration remain for final integration pass where dependent APIs are landing concurrently.
