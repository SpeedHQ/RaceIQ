#!/usr/bin/env bash
# Regenerate dashboard snapshot baselines inside the SAME pinned Playwright
# container that CI uses, so local baselines match the pipeline byte-for-byte.
#
# Usage (from repo root or client/): bun run snapshot:docker   (defined in
# client/package.json), or run this script directly.
#
# Requires Docker. Mounts the repo, installs bun in the container, and runs the
# existing `bun run snapshot` (playwright test --update-snapshots + copy to
# assets/screenshots).
set -euo pipefail

# Keep this in lockstep with @playwright/test in client/package.json and the
# image tag in .github/workflows/pr-screenshots.yml + update-baselines.yml.
IMAGE="mcr.microsoft.com/playwright:v1.62.0-jammy"

# Resolve repo root (this script lives in <repo>/scripts/ui/).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Regenerating baselines in $IMAGE ..."
docker run --rm --ipc=host \
  -v "$REPO_ROOT":/work \
  -v /work/node_modules \
  -v /work/client/node_modules \
  -w /work \
  "$IMAGE" \
  bash -c '
    set -euo pipefail
    export HOME=/tmp
    apt-get update -qq && apt-get install -y -qq --no-install-recommends unzip
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    export RACEIQ_CANONICAL_SNAPSHOT_ENV=1
    bun install --ignore-scripts
    cd client && bun install --ignore-scripts && bun run snapshot
  '

echo "Done. Review and commit client/src/stories/__snapshots__/snapshot-*.png and assets/screenshots/."
