ARG PLAYWRIGHT_VERSION=1.62.1
ARG BUN_VERSION=1.4.3
FROM oven/bun:${BUN_VERSION} AS bun
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
    && apt-get install -y --no-install-recommends git gh ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /smoke
RUN npm init -y \
    && npm pkg set type=module \
    && npm install --no-package-lock --ignore-scripts --save-exact "@playwright/test@${PLAYWRIGHT_VERSION}" \
    && git config --global credential.helper '!gh auth git-credential'
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /smoke/harness
COPY playwright/upgrade-smoke.config.ts ./playwright/upgrade-smoke.config.ts
COPY playwright/support/upgrade/source-release.ts ./playwright/support/upgrade/source-release.ts
COPY playwright/tests/upgrade/source-release.spec.ts ./playwright/tests/upgrade/source-release.spec.ts

ENV CI=true \
    RACEIQ_APP_ROOT=/smoke/harness \
    RACEIQ_UPGRADE_ARTIFACTS_DIR=/artifacts
ENTRYPOINT ["/smoke/node_modules/.bin/playwright", "test", "--config=playwright/upgrade-smoke.config.ts"]
