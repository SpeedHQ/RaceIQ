# Contributing

## Requirements

- [Bun](https://bun.sh)

## Development

```bash
bun install
cd client && bun install && cd ..
bun run dev
```

- Server + API: `http://localhost:3117`
- Client (Vite HMR): `http://localhost:5173`
- Data is stored in `./data/`

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Server | [Hono](https://hono.dev) |
| Database | SQLite + [Drizzle ORM](https://orm.drizzle.team) |
| Frontend | React 19, Vite, TypeScript |
| Routing | TanStack Router (file-based) |
| State | Zustand (client), TanStack Query (server) |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Charts | uPlot |
| 3D | Three.js + React Three Fiber |
| AI | Claude API |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_PORT` | `3117` | HTTP/WebSocket port |
| `UDP_PORT` | `5300` | Telemetry UDP port |
| `DATA_DIR` | `./data` | Database and settings directory |

## Tests

```bash
bun test
bun test test/parser.test.ts   # single file
```

## Track Data

Built-in track outlines and metadata are extracted from game files:

```bash
bun run extract:tracks        # all supported games
bun run extract:tracks:forza  # Forza Motorsport only
bun run extract:tracks:f1     # F1 2025 only
```

Extracted data is written to `shared/track-outlines/` and `shared/tracks.csv`.

Corner names, numbering and segment geometry are a separate, hand-curated layer on top
of that. Before editing corner data — or before "fixing" the segment detector — read
[docs/track-curation.md](docs/track-curation.md). Curated geometry is the source of
truth; the detector is a fallback and is not expected to be 100% accurate.

Curated / verified coverage per game is tracked by hand in the table in
[docs/track-curation.md](docs/track-curation.md) — update it in the same PR that
curates or verifies a track.

## Database

```bash
bun run db:push       # push schema changes
bun run db:generate   # generate migration files
```
