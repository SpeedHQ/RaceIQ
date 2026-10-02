---
name: no-node-modules-research
description: "Do not inspect node_modules to research library usage; use official documentation instead"
condition: "node_modules[\\\\/]"
scope: ["tool:read(node_modules/**)", "tool:grep(node_modules/**)", "tool:glob(node_modules/**)"]
---

Do not read, grep, or glob node_modules for usage research. Use official documentation or public source repositories instead.