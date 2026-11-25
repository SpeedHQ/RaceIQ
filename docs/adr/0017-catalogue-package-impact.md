---
status: accepted
---
# Use package boundaries for catalogue Playwright impact

Cars and Tracks already own their Playwright tests. Both inherit broad client inputs and a `backend-core` transit dependency. A small UI exclusion patch avoids known Home and Experiments false positives, but maintaining an exclusion for each unrelated feature does not scale.

Use the existing feature packages and declared dependencies as the primary Turbo impact boundary. Keep positive inputs for the app-owned seams that packages cannot express. Extract only proven shared backend capabilities that currently pull in unrelated code. Keep real dependencies, full fallback and compiled-app verification; a reduced project set is not evidence of fewer runner jobs.

This decision applies [feature ownership](0015-e2e-aware-package-extraction.md) and [task-level affected verification](0016-task-level-affected-verification.md) to Cars and Tracks. It does not authorize a broad platform split or change product behavior.

Plans: [shared contract and acceptance](../superpowers/plans/catalogue-package-impact-contract.md), [UI](../superpowers/plans/catalogue-package-impact-ui-plan.md), [backend](../superpowers/plans/catalogue-package-impact-backend-plan.md).
