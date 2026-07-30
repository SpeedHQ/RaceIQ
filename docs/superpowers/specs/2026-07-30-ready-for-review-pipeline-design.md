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

Keep the existing draft guard in `build-test.yml`. The screenshot workflow has no draft guard on `main`; adding `ready_for_review` lets its existing eligible render path also run when a draft becomes ready. No duplicate workflow or new dispatch mechanism is needed.

## Behavior

- Opening a draft: `build-test` may run but its jobs are skipped; screenshot behavior remains unchanged.
- Pushing to a draft: `build-test` jobs remain skipped; screenshot behavior remains unchanged.
- Marking draft ready: both workflows receive a new `ready_for_review` run.
- Reopening or updating a ready PR: existing CI behavior remains unchanged.
- Screenshot comment handling remains in `pr-screenshots-comment.yml` and continues to accept non-draft workflow runs.

## Verification

Validate YAML syntax and inspect the resulting trigger expressions. Confirm both modified workflows include `ready_for_review`, retain existing PR activity types, and preserve the build/test draft guards. No application runtime behavior changes.
