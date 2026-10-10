# Docker installation (Linux)

RaceIQ publishes a `linux/amd64` image to GHCR. The image runs as unprivileged user `bun` and stores application state in `/data`.

## Install and run

Requirements: Docker Engine with support for `linux/amd64` images.

Create a private `.env` file containing `SERVER_PASSWORD` (a unique password of at least 8 characters) and `SERVER_ALLOWED_ORIGINS` (for example `http://localhost:3117`). See [network access](network-access.md) for LAN addresses and HTTPS proxy configuration. The container binds to `0.0.0.0` and refuses to start without these settings.

```bash
docker run --detach --name raceiq --restart unless-stopped \
  --env-file .env \
  --publish 3117:3117/tcp \
  --publish 5301:5301/udp \
  --volume raceiq-data:/data \
  ghcr.io/speedhq/raceiq:latest
```

Open <http://localhost:3117> and sign in as `raceiq` with your configured password.

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
  --env-file .env \
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
  --env-file .env \
  --publish 8080:3117/tcp \
  --publish 6301:5301/udp \
  --volume raceiq-data:/data \
  ghcr.io/speedhq/raceiq:latest
```

The image defaults are `SERVER_HOST=0.0.0.0`, `SERVER_PORT=3117`, `UDP_PORT=5301`, and `DATA_DIR=/data`. If changing internal ports with environment variables, keep the corresponding port mappings aligned. Update `SERVER_ALLOWED_ORIGINS` to the browser-facing address and port when changing the published address. The health check uses the configured password.
