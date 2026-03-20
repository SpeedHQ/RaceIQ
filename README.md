# Forza Telemetry

A self-hosted telemetry dashboard for Forza Motorsport and Forza Horizon. Receives UDP data from the game, records lap telemetry, and provides live and historical analysis.

## Requirements

- [Bun](https://bun.sh) (local dev)
- [Docker](https://www.docker.com) with Docker Compose v2 (containerised)

---

## 1. Configure Forza

In-game, enable the **Data Out** feature:

1. Go to **Settings → HUD and Gameplay**
2. Set **Data Out** to `On`
3. Set **Data Out IP Address** to the IP of the machine running this server
4. Set **Data Out Port** to `5300` (default) or your custom `UDP_PORT`
5. Set **Data Out Package Format** to `Car Dash`

---

## 2. Local Development (no Docker)

```bash
bun install
cd client && bun install && cd ..
bun run dev
```

- Server + API: `http://localhost:3117`
- Client (Vite HMR): `http://localhost:5173`
- Data is stored in `./data/`

---

## 3. Docker — Development

Hot reload for both server and client, source bind-mounted.

```bash
docker compose --profile dev up --build
```

| Service | URL |
|---|---|
| Client (Vite) | http://localhost:5173 |
| Server API | http://localhost:3117/api |

Stop with:

```bash
docker compose --profile dev down
```

---

## 4. Docker — Production

Single container. Bun serves the pre-built React app and handles all API/WebSocket/UDP traffic.

```bash
docker compose --profile prod up --build -d
```

- App: `http://localhost:3117`
- Data persisted to `./data/` on the host

Stop with:

```bash
docker compose --profile prod down
```

---

## 5. Coolify Deployment

1. Add a new resource in Coolify → **Docker Compose**
2. Point it at this repository
3. Set the following environment variables in the Coolify dashboard:

| Variable | Value |
|---|---|
| `COMPOSE_PROFILES` | `prod` |
| `UDP_PORT` | Your Forza Data Out port (default: `5300`) |

4. Configure a **persistent volume** mapped to `/app/data` inside the container (Coolify Storage settings)
5. Ensure your host firewall allows **UDP inbound** on `UDP_PORT`
6. Deploy

> **Note:** The UDP telemetry listener requires a direct UDP port — Railway is not supported. Use Coolify on a VPS or home server.

---

## Environment Variables

Copy `.env.example` to `.env` to override defaults for local Docker use:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `SERVER_PORT` | `3117` | HTTP/WebSocket port |
| `UDP_PORT` | `5300` | Forza telemetry UDP port |
| `DATA_DIR` | `/app/data` | Database and settings directory (inside container) |
| `PROXY_TARGET` | `http://server-dev:3117` | Vite dev proxy target (dev containers only) |

---

## Data

All data is stored in `./data/`:

- `forza-telemetry.db` — SQLite database (laps, sessions, analyses)
- `settings.json` — App settings (UDP port, units, active profile)

The database schema is created automatically on first run. No manual migration step required.
