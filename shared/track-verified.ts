/**
 * Human-verification ledger for track data.
 *
 * Curated ≠ correct. A roster can be hand-authored and still wrong, and the
 * per-game geometry the app renders can be plain bad (f1-2025 segments are known
 * inaccurate). "Verified" means a human compared the data against a real
 * turn-by-turn guide / circuit map — or, for segments, the committed render in
 * `test/e2e/output/track-segments/<slug>-<gameId>.svg` — and signed it off.
 *
 * Entries are keyed by the **path of the file signed**, relative to the repo root:
 *   - `shared/tracks/meta/<slug>.json`              — the shared roster.
 *   - `shared/tracks/<gameId>/<slug>-segments.json` — that game's geometry.
 *
 * The key *is* the record of what was checked; nothing else needs to encode kind.
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
  /** Who signed it — a person, never a tool. */
  by?: string;
  /** What they checked it against. */
  note?: string;
}

/** Repo-relative file path → sign-off. */
export type VerifiedLedger = Record<string, VerifiedEntry>;

export function loadVerified(): VerifiedLedger {
  if (!existsSync(VERIFIED_FILE)) return {};
  return JSON.parse(readFileSync(VERIFIED_FILE, "utf8")) as VerifiedLedger;
}

export function saveVerified(ledger: VerifiedLedger): void {
  const sorted = Object.fromEntries(Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(VERIFIED_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Ledger key for a verifiable file: its path relative to the repo root. */
export function verifiedKey(kind: "meta" | "segments", slug: string, gameId?: GameId): string {
  return kind === "meta"
    ? `shared/tracks/meta/${slug}.json`
    : `shared/tracks/${gameId ?? ""}/${slug}-segments.json`;
}

/** Absolute path of the file a signature covers, or null if it doesn't exist. */
export function verifiableFile(kind: "meta" | "segments", slug: string, gameId?: GameId): string | null {
  const p = resolve(SHARED_DIR, verifiedKey(kind, slug, gameId).replace(/^shared\//, ""));
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
  const entry = ledger[verifiedKey(kind, slug, gameId)];
  if (!entry) return "unverified";
  return entry.hash === fileHash(verifiableFile(kind, slug, gameId)) ? "verified" : "stale";
}

/** Stamp a sign-off. Throws when the target file doesn't exist. */
export function stampVerified(
  kind: "meta" | "segments",
  slug: string,
  opts: { gameId?: GameId; by?: string; note?: string; date?: string } = {},
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
    ...(opts.note ? { note: opts.note } : {}),
  };
  const ledger = loadVerified();
  ledger[verifiedKey(kind, slug, opts.gameId)] = entry;
  saveVerified(ledger);
  return entry;
}
