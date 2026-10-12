# Docker installation (Linux)

RaceIQ publishes a `linux/amd64` image to GHCR. The image runs as unprivileged user `bun` and stores application state in `/data`.

## Install and run

Requirements: Docker Engine with support for `linux/amd64` images.

The image binds to `0.0.0.0` inside the container. Choose optional password protection during dashboard setup; application APIs remain unavailable until you make that choice. Restrict the published dashboard port to localhost until setup is complete. Anyone reaching a remotely exposed, unconfigured instance can claim it. See [access and security](network-access.md).

```bash
docker run --detach --name raceiq --restart unless-stopped \
  --publish 127.0.0.1:3117:3117/tcp \
  --publish 5301:5301/udp \
  --volume raceiq-data:/data \
  ghcr.io/speedhq/raceiq:latest
```

Open <http://localhost:3117> and choose password protection or explicitly confirm unprotected access. To allow other devices afterward, recreate the container with the dashboard port published on the intended host address, retaining the same volume. Sign in using the password alone. Optional `--env-file .env` overrides are identified in Settings → Access & security.

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
  --publish 127.0.0.1:3117:3117/tcp \
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

The image defaults are `SERVER_HOST=0.0.0.0`, `SERVER_PORT=3117`, `UDP_PORT=5301`, and `DATA_DIR=/data`. The bind override controls interfaces inside the container; Docker's published address controls host exposure. Keep port mappings and browser origins aligned when changing ports. The health check probes the public login/setup shell and does not require a browser session. Keep optional `--env-file .env` arguments when replacing the container.

Password hashes, explicit disabled protection, and sessions persist in the database on `/data`. Recover a forgotten UI-managed password with `docker exec -it raceiq ./raceiq auth reset`; input is hidden and previous sessions are invalidated. Remove `SERVER_PASSWORD` by recreating the container with the same volume before recovering a password managed through the UI.
