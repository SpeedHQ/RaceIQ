# Scrapers

Network-backed seed and guide collectors. Entry points under `scripts/scrapers/` remain side-effectful; parsers, source adapters, and output helpers under domain folders are import-safe.

| Entry point | Sources | Output |
|---|---|---|
| `scrape-acc-setups.ts` | accsetups.com; YouTube metadata | `shared/data/tunes/acc/accsetups-com/` |
| `scrape-car-specs.ts` | Forza Fandom Wiki API and image CDN | `shared/games/fm-2023/car-specs.csv`, `client/public/car-images/` |
| `scrape-f1-leaderboards.ts` | f1laps.com | `shared/data/tunes/f1-25/f1laps/` |
| `scrape-f1-setups.ts` | f1laps.com, simracingsetup.com, overtake.gg | `shared/data/tunes/f1-25/{f1laps,simracingsetup,overtake}/` |

## Network policy

- F1 sources retry failed requests up to three attempts with 2 s / 4 s backoff.
- ACC keeps site request order and 400 ms car throttle; YouTube metadata uses five workers and 150 ms per-item delay.
- F1Laps setup details use three workers and 300 ms per-item delay; track orchestration uses four workers.
- Leaderboards use six workers with shared F1 retry policy.
- Car Wiki page/image batches remain 50 requests per batch with 300 ms between batches; HTML fallback and image downloads remain capped at ten concurrent requests.

`http.ts` owns retry/delay HTTP primitives; `pool.ts` owns bounded concurrency. Scraper adapters own source-specific headers and parsing. Output modules own merge/upsert behavior and generated artifact paths.
