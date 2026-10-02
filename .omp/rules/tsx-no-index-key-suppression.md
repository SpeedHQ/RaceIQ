---
name: tsx-no-index-key-suppression
description: "Reject noArrayIndexKey suppressions in affected React components"
condition: ["GearRatioChart\\.tsx[\\s\\S]*oxlint-disable-next-line", "InputOverlay\\.tsx[\\s\\S]*oxlint-disable-next-line"]
scope: "tool"
---

Do not suppress array-index-key diagnostics. Fix identity at source with stable domain IDs or stable source-data keys. If no compliant identity exists, stop before editing: explain concrete tradeoffs and ask which model change is acceptable.
