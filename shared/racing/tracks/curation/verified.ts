/** Human-verification ledger for canonical track facts and per-game geometry. */

import { createHash } from "node:crypto";
import type { GameId } from "@shared/games/ids";
import { getTrackRegistry, getTrackRegistryIndexes } from "../registry";
import { updateTrackRegistrySource } from "../registry/update";
import { loadTrackFacts, loadTrackGeometryForGame } from "../storage/meta";

export interface VerifiedEntry {
  /** Short SHA-256 of normalized registry rows at sign-off. */
  hash: string;
  /** ISO date of sign-off. */
  date: string;
  /** Who signed it — a person, never a tool. */
  by?: string;
  /** What they checked it against. */
  note?: string;
}

export type VerifiedLedger = Record<string, VerifiedEntry>;



export function verifiedKey(kind: "meta" | "segments", slug: string, gameId?: GameId): string {
  return kind === "meta" ? `meta:${slug}` : `segments:${gameId ?? ""}/${slug}`;
}

export function loadVerified(): VerifiedLedger {
  return structuredClone(getTrackRegistry().verification);
}

export function saveVerified(ledger: VerifiedLedger): void {
  updateTrackRegistrySource((draft) => {
    draft.verification.entries = ledger;
  });
}

/** Hash normalized registry rows for one shared roster or one game's geometry. */
export function registryDataHash(kind: "meta" | "segments", slug: string, gameId?: GameId): string | null {
  let value: unknown;
  if (kind === "meta") {
    value = loadTrackFacts(slug);
  } else {
    if (!gameId) return null;
    const exists = getTrackRegistryIndexes().geometryByFactsSlug.get(slug)?.has(gameId) ?? false;
    value = exists ? loadTrackGeometryForGame(slug, gameId) : null;
  }
  return value ? createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12) : null;
}

export type VerifyState = "verified" | "stale" | "unverified";

export function verifyState(ledger: VerifiedLedger, kind: "meta" | "segments", slug: string, gameId?: GameId): VerifyState {
  const entry = ledger[verifiedKey(kind, slug, gameId)];
  if (!entry) return "unverified";
  return entry.hash === registryDataHash(kind, slug, gameId) ? "verified" : "stale";
}

export function stampVerified(kind: "meta" | "segments", slug: string, opts: { gameId?: GameId; by?: string; note?: string; date?: string } = {}): VerifiedEntry {
  const hash = registryDataHash(kind, slug, opts.gameId);
  if (!hash) throw new Error(`no ${kind} registry rows to verify for ${slug}${opts.gameId ? ` (${opts.gameId})` : ""}`);
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
