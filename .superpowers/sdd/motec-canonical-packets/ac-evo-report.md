# AC Evo direct packet conversion

Replaced AC Evo MoTeC BIN/shared-memory serialization path with direct `TelemetryPacket` conversion. Converter preallocates one canonical packet per 60 Hz sample and returns provenance metadata. Shared Kunos preparation now supports AC Evo suspension unit normalization and centering, with heading retained in dead-reckoned path. Legacy resolver/helper exports remain temporarily available for target migration compatibility.

Focused test invocation currently exposes unrelated in-flight target/import migration failures and existing reconstruction expectation differences; main integration branch must complete target/import cutover before full validation.
