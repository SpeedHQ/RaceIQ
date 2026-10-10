FROM oven/bun:1.4.2 AS builder

WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
ARG RELEASE_VERSION
RUN if [ -n "$RELEASE_VERSION" ]; then bun scripts/ci/update-release-version.ts "$RELEASE_VERSION"; fi
RUN RACEIQ_DOCKER_BUILD=1 bun run build

FROM oven/bun:1.4.2 AS runtime
LABEL org.opencontainers.image.title="RaceIQ" \
      org.opencontainers.image.description="RaceIQ Linux container for telemetry dashboards, lap analysis, catalogue, imports, and UDP telemetry." \
      org.opencontainers.image.url="https://github.com/SpeedHQ/RaceIQ" \
      org.opencontainers.image.source="https://github.com/SpeedHQ/RaceIQ" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app
COPY --from=builder --chown=bun:bun /app/dist/ ./
RUN mkdir /data && chown bun:bun /data
ENV NODE_ENV=production \
    DATA_DIR=/data \
    SERVER_PORT=3117 \
    SERVER_HOST=0.0.0.0 \
    UDP_PORT=5301

VOLUME ["/data"]
EXPOSE 3117/tcp
EXPOSE 5301/udp

USER bun

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.SERVER_PORT}/`, {headers: {Authorization: 'Basic ' + Buffer.from('raceiq:' + process.env.SERVER_PASSWORD).toString('base64')}}).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]
ENTRYPOINT ["./raceiq"]
