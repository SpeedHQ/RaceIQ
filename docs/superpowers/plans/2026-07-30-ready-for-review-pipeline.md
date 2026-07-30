# Ready-for-Review PR Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start existing PR CI workflows when a draft PR becomes ready for review.

**Architecture:** Extend existing `pull_request` activity filters in the build/test and screenshot workflows. Preserve the build/test job-level draft guards so drafts remain skipped while `ready_for_review` creates a new eligible run; the screenshot workflow keeps its existing behavior and gains the missing activity type.

**Tech Stack:** GitHub Actions YAML, Git

## Global Constraints

- Keep draft PR jobs skipped.
- Add `ready_for_review` without removing `opened`, `synchronize`, or `reopened` behavior.
- Do not create duplicate workflows or change application code.

---

### Task 1: Trigger CI on ready-for-review

**Files:**
- Modify: `.github/workflows/build-test.yml:3-8`
- Modify: `.github/workflows/pr-screenshots.yml:12-19`
- Test: workflow YAML and trigger/guard assertions via shell inspection

**Interfaces:**
- Consumes: GitHub `pull_request` activity events.
- Produces: New workflow runs for `ready_for_review` events while retaining existing PR events and draft guards.

- [ ] **Step 1: Add explicit PR activity types**

In both workflows, change the existing PR trigger to:

```yaml
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
```

Keep the existing `if: github.event_name != 'pull_request' || !github.event.pull_request.draft` guards unchanged in `build-test.yml`. Do not add a new screenshot guard; `.github/workflows/pr-screenshots.yml` has no draft guard on `main`.

- [ ] **Step 2: Verify workflow structure**

Run:

```bash
ruby -e 'require "yaml"; ARGV.each { |path| YAML.load_file(path); puts "valid #{path}" }' .github/workflows/build-test.yml .github/workflows/pr-screenshots.yml
```

Expected: both files parse successfully.

- [ ] **Step 3: Verify event and guard contract**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
for name in ("build-test.yml", "pr-screenshots.yml"):
    text = Path(".github/workflows", name).read_text()
    assert "ready_for_review" in text
    assert "types: [opened, synchronize, reopened, ready_for_review]" in text
print("ready_for_review triggers present")
text = Path(".github/workflows/build-test.yml").read_text()
assert text.count("!github.event.pull_request.draft") == 2
print("build draft guards retained")
PY
```

Expected: all assertions pass.

- [ ] **Step 4: Commit workflow change**

```bash
git add .github/workflows/build-test.yml .github/workflows/pr-screenshots.yml
git commit -m "fix: run PR pipeline when draft becomes ready"
```
