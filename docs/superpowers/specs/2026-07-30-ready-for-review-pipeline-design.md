# Ready-for-Review PR Pipeline Design

## Problem

Draft pull requests intentionally skip CI jobs, but GitHub's default `pull_request` activity types do not include `ready_for_review`. When a draft becomes ready, no new workflow run is created, so the jobs remain skipped.

## Design

Extend the existing PR triggers in:

- `.github/workflows/build-test.yml`
- `.github/workflows/pr-screenshots.yml`

Use explicit activity types:

- `opened`
- `synchronize`
- `reopened`
- `ready_for_review`

Keep each workflow's existing `!draft` job guard. Draft PRs continue to avoid CI; converting to ready creates a fresh run that executes the same pipeline. No duplicate workflow or new dispatch mechanism is needed.

## Behavior

- Opening a draft: workflow run may exist but jobs remain skipped.
- Pushing to a draft: jobs remain skipped.
- Marking draft ready: new workflow run starts and jobs execute.
- Reopening or updating a ready PR: existing CI behavior remains unchanged.
- Screenshot comment handling remains in `pr-screenshots-comment.yml` and continues to accept non-draft workflow runs.

## Verification

Validate YAML syntax and inspect the resulting trigger expressions. Confirm both modified workflows include `ready_for_review` alongside the existing default PR activities and retain draft guards. No application runtime behavior changes.
