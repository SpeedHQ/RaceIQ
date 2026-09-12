---
name: tsx-no-biome-ignore
description: "Reject noArrayIndexKey suppressions in affected React components"
condition: ["GearRatioChart\\.tsx[\\s\\S]*biome-ignore\\s+lint/suspicious/noArrayIndexKey", "InputOverlay\\.tsx[\\s\\S]*biome-ignore\\s+lint/suspicious/noArrayIndexKey"]
scope: "tool"
---

Do not suppress `noArrayIndexKey`. Fix identity at source with stable domain IDs or stable source-data keys. If no compliant identity exists, stop before editing: cite Biome’s `noArrayIndexKey` reference, explain concrete tradeoffs, and ask which model change is acceptable.