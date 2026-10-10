# Docker installation (Linux)

RaceIQ publishes a `linux/amd64` image to GHCR. The image runs as unprivileged user `bun` and stores application state in `/data`.

## Install and run

Requirements: Docker Engine with support for `linux/amd64` images.

No new environment variables are required. The container continues to bind to `0.0.0.0` and starts without a password or origin list. Password protection and a comma-separated trusted-origin list are independent, optional settings; see [network access](network-access.md) for LAN, Tailnet, and HTTPS proxy examples.

```bash
docker run --detach --name raceiq --restart unless-stopped \
  --publish 3117:3117/tcp \
  --publish 5301:5301/udp \
  --volume raceiq-data:/data \
  ghcr.io/speedhq/raceiq:latest
```

Open <http://localhost:3117>. If you choose to set `SERVER_PASSWORD`, add `--env-file .env` to the Docker command and sign in as `raceiq` with that password. The same env-file option can supply `SERVER_ALLOWED_ORIGINS` without enabling a password.

Do not add `--privileged`, `--user root`, or `sudo`. Named volume `raceiq-data` preserves database, settings, recordings, and other application state across container replacement.

## Telemetry

For Forza Motorsport and F1, configure the game to send UDP telemetry to the Docker host address on port `5301`. Do not use the container's loopback address.

The Linux image supports browser UI, UDP telemetry, imports, analysis, catalogue features, and persisted history. ACC, Assetto Corsa Evo, and iRacing live shared-memory capture require Windows.

## Update

Pull the new image, replace the container, and keep the same named volume:

```bash
docker pull ghcr.io/speedhq/raceiq:latest
docker rm --force raceiq
docker run --detach --name raceiq --restart unless-stopped \
  --publish 3117:3117/tcp \
  --publish 5301:5301/udp \
  --volume raceiq-data:/data \
  ghcr.io/speedhq/raceiq:latest
```

Use a version tag instead of `latest` when pinning deployments, for example `ghcr.io/speedhq/raceiq:0.17.1`.

## Roll back `latest`

To restore a previous published image, open **Actions → Roll Back Docker Image → Run workflow**. Enter either the version (`0.17.0`) or release tag (`v0.17.0`). Workflow retargets `latest` to existing immutable version image; it does not rebuild image or change version tag.

Then recreate container using same update commands above. Named volume remains intact.

## Publish a branch image

To run image publication manually, open **Actions → Publish Docker Image → Run workflow**. Set:

- **Image version tag:** `0.0.1`
- **Branch or ref:** `Snazzie/docker`
- **Also move latest tag:** disabled for isolated testing

Workflow publishes `ghcr.io/speedhq/raceiq:0.0.1` from selected ref. Enable `latest` only when intentionally promoting test image.

## Configuration

Override published ports while preserving the server's internal ports through Docker mappings. For example:

```bash
docker run --detach --name raceiq \
  --publish 8080:3117/tcp \
  --publish 6301:5301/udp \
  --volume raceiq-data:/data \
  ghcr.io/speedhq/raceiq:latest
```

The image defaults are `SERVER_HOST=0.0.0.0`, `SERVER_PORT=3117`, `UDP_PORT=5301`, and `DATA_DIR=/data`. If changing internal ports with environment variables, keep the corresponding port mappings aligned. If you configured `SERVER_ALLOWED_ORIGINS`, update it to the browser-facing address and port when changing the published address. The health check works without a password and sends authentication only when a password is configured. Keep any optional `--env-file .env` argument when replacing the container.
