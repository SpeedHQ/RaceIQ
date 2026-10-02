---
name: disclose-automated-agent-in-review-replies
description: "Prefix every automated GitHub review reply with explicit AI-agent authorship disclosure"
condition: "gh api\\s+--method\\s+POST\\s+repos/\\S+/pulls/\\d+/comments/\\d+/replies\\s+-f[\\s\\S]{0,20}?body=(?![^\\r\\n]{0,60}(?:[Aa]utomated AI agent|AI-generated))"
scope: "tool:bash"
---

Every GitHub review reply posted by automation MUST begin with an explicit disclosure, such as **Automated AI agent response:**. Add disclosure to `body` before invoking `gh api`; never publish AI-written replies as if human-authored.