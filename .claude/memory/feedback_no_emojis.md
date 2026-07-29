---
name: feedback-no-emojis
description: "Never use emojis in output, commit messages, or PR bodies"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d9a5009b-eb60-4a03-b70e-cff7fd245dff
  modified: 2026-07-28T14:46:05.005Z
---

Do not use emojis anywhere — chat replies, commit messages, PR titles/bodies, code, or UI copy. Use plain text or lucide icon components instead.

**Why:** acoop asked for this directly (2026-07-28) after a PR body and reply used emoji glyphs.

**How to apply:** strip emojis from generated PR/commit text (including the "Generated with Claude Code" line's robot glyph) and from any example UI strings quoted back. In UI code, icons come from lucide-react, not emoji characters. Related: [[feedback_git_workflow]]
