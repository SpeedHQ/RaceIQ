/**
 * Human-verification ledger for track data.
 *
 * Curated ≠ correct. A roster can be hand-authored and still wrong, and the
 * per-game geometry the app renders can be plain bad (f1-2025 segments are known
 * inaccurate). "Verified" means a human compared the data against a real
 * turn-by-turn guide / circuit map — or, for segments, the committed render in
 * `test/e2e/output/track-segments/<slug>-<gameId>.svg` — and signed it off.
 *
 * Two independent axes, because they are curated separately:
 *   - `meta`     — the shared roster `shared/tracks/meta/<slug>.json` (per slug,
 *                  shared by every game running that layout).
 *   - `segments` — the per-game geometry `shared/tracks/<gameId>/<slug>-segments.json`.
 *
 * Each entry pins a hash of the file it signed off. Change the file and the
 * signature goes **stale** — it stops counting as verified until a human looks
 * again and re-stamps (`bun run tracks:coverage --verify ...`). Nothing here is
 * inferred; entries only ever arrive by a person adding them.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "./resolve-data";
import type { GameId } from "./types";

export const VERIFIED_FILE = resolve(SHARED_DIR, "tracks", "verified.json");

export interface VerifiedEntry {
  /** Short sha256 of the file contents at sign-off. */
  hash: string;
  /** ISO date of sign-off. */
  date: string;
  /** Who / what it was checked against. */
  by?: string;
}

export interface VerifiedLedger {
  /** slug → entry, for `shared/tracks/meta/<slug>.json`. */
  meta: Record<string, VerifiedEntry>;
  /** gameId → slug → entry, for `shared/tracks/<gameId>/<slug>-segments.json`. */
  segments: Partial<Record<GameId, Record<string, VerifiedEntry>>>;
}

const EMPTY: VerifiedLedger = { meta: {}, segments: {} };

export function loadVerified(): VerifiedLedger {
  if (!existsSync(VERIFIED_FILE)) return structuredClone(EMPTY);
  const raw = JSON.parse(readFileSync(VERIFIED_FILE, "utf8")) as Partial<VerifiedLedger>;
  return { meta: raw.meta ?? {}, segments: raw.segments ?? {} };
}

export function saveVerified(ledger: VerifiedLedger): void {
  const meta = Object.fromEntries(Object.entries(ledger.meta).sort(([a], [b]) => a.localeCompare(b)));
  const segments: VerifiedLedger["segments"] = {};
  for (const gameId of Object.keys(ledger.segments).sort() as GameId[]) {
    const byGame = ledger.segments[gameId] ?? {};
    segments[gameId] = Object.fromEntries(Object.entries(byGame).sort(([a], [b]) => a.localeCompare(b)));
  }
  writeFileSync(VERIFIED_FILE, `${JSON.stringify({ meta, segments }, null, 2)}\n`);
}

/** Path of the file a verification signature covers, or null if it doesn't exist. */
export function verifiableFile(kind: "meta" | "segments", slug: string, gameId?: GameId): string | null {
  const p =
    kind === "meta"
      ? resolve(SHARED_DIR, "tracks", "meta", `${slug}.json`)
      : resolve(SHARED_DIR, "tracks", gameId ?? "", `${slug}-segments.json`);
  return existsSync(p) ? p : null;
}

/** Short content hash used as the signature. Null when the file is missing. */
export function fileHash(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

export type VerifyState = "verified" | "stale" | "unverified";

/** Compare a ledger entry against the file it signed. */
export function verifyState(
  ledger: VerifiedLedger,
  kind: "meta" | "segments",
  slug: string,
  gameId?: GameId,
): VerifyState {
  const entry = kind === "meta" ? ledger.meta[slug] : gameId ? ledger.segments[gameId]?.[slug] : undefined;
  if (!entry) return "unverified";
  return entry.hash === fileHash(verifiableFile(kind, slug, gameId)) ? "verified" : "stale";
}

/** Stamp a sign-off. Throws when the target file doesn't exist. */
export function stampVerified(
  kind: "meta" | "segments",
  slug: string,
  opts: { gameId?: GameId; by?: string; date?: string } = {},
): VerifiedEntry {
  const path = verifiableFile(kind, slug, opts.gameId);
  const hash = fileHash(path);
  if (!hash) {
    throw new Error(`no ${kind} file to verify for ${slug}${opts.gameId ? ` (${opts.gameId})` : ""}`);
  }
  const entry: VerifiedEntry = {
    hash,
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    ...(opts.by ? { by: opts.by } : {}),
  };
  const ledger = loadVerified();
  if (kind === "meta") ledger.meta[slug] = entry;
  else {
    const gameId = opts.gameId as GameId;
    (ledger.segments[gameId] ??= {})[slug] = entry;
  }
  saveVerified(ledger);
  return entry;
}
