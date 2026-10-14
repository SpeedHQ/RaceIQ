import Database from "libsql";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveOnlineDataDir } from "./runtime";

const PreferencesSchema = z.object({ visibility: z.enum(["private", "public"]), setupUploads: z.boolean() }).strict();
const AccountProfileSchema = z.object({ userId: z.string().min(1), displayName: z.string(), avatarUrl: z.string().nullable(), discordUsername: z.string().min(1).nullable().optional() }).strict();
const ConsentSchema = z.object({ termsVersion: z.string(), privacyVersion: z.string(), acceptedAt: z.string() }).strict();
const StateSchema = z.object({
  accountEpoch: z.string().min(1), revision: z.number().int().nonnegative(),
  profile: AccountProfileSchema.nullable().default(null),
  preferences: PreferencesSchema.nullable(), persistedPreferences: PreferencesSchema.nullable(),
  preferencePersistence: z.enum(["unconfirmed", "confirmed", "pending", "failed"]),
  consent: ConsentSchema.nullable(), privacyBarrier: z.boolean(), setupBarrier: z.boolean(),
}).strict();

export type PersistedOnlineState = z.infer<typeof StateSchema>;

function initial(): PersistedOnlineState {
  return { accountEpoch: randomUUID(), revision: 0, profile: null, preferences: null, persistedPreferences: null,
    preferencePersistence: "unconfirmed", consent: null, privacyBarrier: true, setupBarrier: true };
}


export class OnlineStateStorage {
  private readonly path: string;
  constructor(dataDir = resolveOnlineDataDir()) { this.path = join(dataDir, "raceiq-online-state.db"); }

  private open() {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      db.exec("CREATE TABLE IF NOT EXISTS online_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  load(): PersistedOnlineState {
    const db = this.open();
    try {
      const row = db.prepare("SELECT payload FROM online_state WHERE id = 1").get() as { payload: string } | undefined;
      if (!row) return initial();
      const parsed = StateSchema.safeParse(JSON.parse(row.payload) as unknown);
      if (!parsed.success) return initial();
      const value = parsed.data;
      return { ...value, privacyBarrier: value.privacyBarrier || value.preferences?.visibility !== "public",
        setupBarrier: value.setupBarrier || value.preferences?.setupUploads !== true };
    } catch { return initial(); }
    finally { db.close(); }
  }

  save(state: PersistedOnlineState): void {
    const payload = JSON.stringify(StateSchema.parse(state));
    const db = this.open();
    try {
      // SQLite's synchronous commit is portable to the packaged Windows runtime;
      // POSIX-only directory fsync must not be a privacy persistence prerequisite.
      db.prepare("INSERT INTO online_state(id, payload) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(payload);
    } finally { db.close(); }
  }
}
