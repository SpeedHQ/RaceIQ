
## Mapping-status remediation

Schema definition guards now validate `mappingStatus` against the complete `TelemetryLinkKind` union (`direct`, `normalized`, `derived`, `simplified`, `unavailable`); malformed mapping status test added. Focused rerun: 4 passed, 0 failed, 20 expectations.
