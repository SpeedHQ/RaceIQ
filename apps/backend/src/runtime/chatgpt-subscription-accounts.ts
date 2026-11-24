import { createClient, type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ChatGptSubscriptionState } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import { ChatGptAccountError, type ChatGptAccountService } from "../routes/chatgpt-subscription-routes";
import { ChatGptOAuthError, createChatGptOAuthClient, listenForChatGptAuthorization } from "./chatgpt-subscription-oauth";
import { createChatGptMacKeychain } from "./platform/chatgpt-mac-keychain";

const secret = z.object({ accessToken: z.string(), refreshToken: z.string(), idToken: z.string(), expiresAt: z.number(), scopes: z.array(z.string()) });
const account = z.object({ id: z.uuid(), label: z.string(), registration: z.object({
  clientId: z.string(), subject: z.string(), email: z.string().nullable(),
}), session: secret.nullable(), reauthRequired: z.boolean().optional() });
const record = z.object({ hostId: z.string(), activeAccountId: z.uuid().nullable(), accounts: z.array(account) });
type RecordState = z.infer<typeof record>;

export interface ChatGptAccountBinding {
  accountId: string;
  signal: AbortSignal;
  token(): Promise<string>;
}

export interface ChatGptMacAccounts extends ChatGptAccountService {
  bindActive(): Promise<ChatGptAccountBinding>;
}

export function createChatGptMacAccounts(dataDir: string): ChatGptMacAccounts {
  const oauth = createChatGptOAuthClient();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let attempt: ChatGptSubscriptionState["attempt"] = null;
  let pending: { cancel(): void; done: Promise<void> } | null = null;
  let committing = false;
  let snapshot: RecordState | null = null;
  let blocked = false;
  const sessionSignals = new Map<string, AbortController>();
  const renewable = new Map<string, Promise<string>>();
  const revoking = new Set<string>();
  let root: Promise<string> | undefined;
  const resolveRoot = () => (root ??= realpath(dataDir));

  async function read() {
    try {
      const store = createChatGptMacKeychain(await resolveRoot());
      const value = await store.read();
      return value ? record.parse(JSON.parse(decoder.decode(value))) : { hostId: `urn:uuid:${randomUUID()}`, activeAccountId: null, accounts: [] } satisfies RecordState;
    } catch {
      throw new ChatGptAccountError("storage_failed");
    }
  }

  async function save(next: RecordState) {
    try {
      await createChatGptMacKeychain(await resolveRoot()).replace(encoder.encode(JSON.stringify(next)));
    } catch {
      blocked = true;
      for (const session of sessionSignals.values()) session.abort();
      sessionSignals.clear();
      throw new ChatGptAccountError("storage_failed");
    }
  }

  async function acquire() {
    let db: Client | undefined;
    try {
      const url = pathToFileURL(join(await resolveRoot(), ".chatgpt-subscription-lock.db")).href;
      const client = db = createClient({ url });
      const transaction = await client.transaction("write");
      return { close() {
        try { transaction.close(); } finally { client.close(); }
      } };
    } catch (failure) {
      db?.close();
      const code = failure instanceof Error && "code" in failure && typeof failure.code === "string" ? failure.code : "";
      throw new ChatGptAccountError(code.startsWith("SQLITE_BUSY") ? "attempt_in_progress" : "storage_failed");
    }
  }

  function state(value: RecordState): ChatGptSubscriptionState {
    return {
      availability: blocked ? "unavailable" : "available",
      activeAccountId: blocked ? null : value.activeAccountId,
      accounts: blocked ? [] : value.accounts.map(({ id, label, session, reauthRequired }) => ({
        id, label, session: session ? "connected" : reauthRequired ? "reauth_required" : "signed_out",
      })),
      attempt,
    };
  }

  async function tokenFor(accountId: string, idToken: string, signal: AbortSignal) {
    if (blocked) throw new ChatGptAccountError("storage_failed");
    if (revoking.has(accountId)) throw new ChatGptAccountError("reauth_required");
    signal.throwIfAborted();
    const current = await read();
    const existing = current.accounts.find((item) => item.id === accountId && item.session?.idToken === idToken);
    if (!existing?.session) throw new ChatGptAccountError("reauth_required");
    if (existing.session.expiresAt > Date.now() + 60_000) {
      signal.throwIfAborted();
      return existing.session.accessToken;
    }
    const existingRefresh = renewable.get(accountId);
    if (existingRefresh) return existingRefresh;
    const refreshing = (async () => {
      const lock = await acquire();
      try {
        signal.throwIfAborted();
        const latest = await read();
        const target = latest.accounts.find((item) => item.id === accountId && item.session?.idToken === idToken);
        if (!target?.session) throw new ChatGptAccountError("reauth_required");
        if (target.session.expiresAt > Date.now() + 60_000) return target.session.accessToken;
        try {
          const updated = await oauth.refresh(target.registration.clientId, target.session.refreshToken, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
          signal.throwIfAborted();
          await save({ ...latest, accounts: latest.accounts.map((item) =>
            item.id === accountId ? { ...item, session: { ...updated, idToken } } : item) });
          return updated.accessToken;
        } catch (error) {
          if (!(error instanceof ChatGptOAuthError)) throw error;
          if (error.code === "reauth_required" || error.code === "plan_unavailable") {
            sessionSignals.get(accountId)?.abort();
            sessionSignals.delete(accountId);
            await save({ ...latest, activeAccountId: latest.activeAccountId === accountId ? null : latest.activeAccountId,
              accounts: latest.accounts.map((item) => item.id === accountId ? { ...item, session: null, reauthRequired: true } : item) });
          }
          throw new ChatGptAccountError(error.code === "plan_unavailable" || error.code === "reauth_required" ? error.code : "upstream_unavailable");
        }
      } finally { lock.close(); }
    })();
    renewable.set(accountId, refreshing);
    try { return await refreshing; } finally { renewable.delete(accountId); }
  }

  return {
    async bindActive() {
      if (blocked) throw new ChatGptAccountError("storage_failed");
      const current = await read();
      const selected = current.accounts.find((item) => item.id === current.activeAccountId);
      if (!selected?.session || revoking.has(selected.id)) throw new ChatGptAccountError("reauth_required");
      const idToken = selected.session.idToken;
      const controller = sessionSignals.get(selected.id) ?? new AbortController();
      sessionSignals.set(selected.id, controller);
      return { accountId: selected.id, signal: controller.signal, token: () => tokenFor(selected.id, idToken, controller.signal) };
    },
    async state() {
      if (blocked) return { availability: "unavailable", activeAccountId: null, accounts: [], attempt };
      try {
        return state(pending && snapshot ? snapshot : await read());
      } catch {
        return { availability: "unavailable", activeAccountId: null, accounts: [], attempt: null };
      }
    },
    async connect(accountId) {
      if (blocked) throw new ChatGptAccountError("storage_failed");
      const lock = await acquire();
      try {
        const current = await read();
        snapshot = current;
        const saved = current.accounts.find((item) => item.id === accountId);
        if (accountId && !saved) throw new ChatGptAccountError("invalid_request");
        if (!current.accounts.length && !saved) await save(current);
        const id = randomUUID();
        const listener = listenForChatGptAuthorization(oauth, current.hostId, saved?.registration ?? null);
        attempt = { id, accountId, status: "pending", error: null };
        const done = listener.outcome.then(async (outcome) => {
          if (outcome.status === "failed") {
            attempt = { id, accountId, status: "failed", error: outcome.error };
          } else if (outcome.status === "cancelled") {
            attempt = { id, accountId, status: "cancelled", error: null };
          } else {
            committing = true;
            const { registration, session } = outcome.grant;
            const match = current.accounts.find((item) => item.registration.clientId === registration.clientId);
            if (match && match.registration.subject !== registration.subject) {
              attempt = { id, accountId, status: "failed", error: "oauth_invalid" };
              return;
            }
            const existing = saved ?? match;
            const nextId = existing?.id ?? randomUUID();
            const label = existing?.label ?? `${registration.email || "ChatGPT"} (${current.accounts.length + 1})`;
            const next = { id: nextId, label, registration, session };
            await save({ ...current, activeAccountId: current.activeAccountId ?? nextId,
              accounts: existing ? current.accounts.map((item) => item.id === nextId ? next : item) : [...current.accounts, next] });
            sessionSignals.get(nextId)?.abort();
            sessionSignals.delete(nextId);
            attempt = { id, accountId: nextId, status: "succeeded", error: null };
          }
        }).catch(() => { attempt = { id, accountId, status: "failed", error: "storage_failed" }; }).finally(() => {
          committing = false;
          pending = null;
          snapshot = null;
          lock.close();
        });
        pending = { cancel: listener.cancel, done };
        return { attemptId: id, authorizationUrl: listener.authorizationUrl };
      } catch (error) {
        lock.close();
        throw error;
      }
    },
    async cancel(attemptId) {
      if (!pending || attempt?.id !== attemptId || attempt.status !== "pending") return;
      if (!committing) pending.cancel();
      await pending.done;
    },
    async activate(accountId) {
      if (blocked) throw new ChatGptAccountError("storage_failed");
      const lock = await acquire();
      try {
        const current = await read();
        if (!current.accounts.some((item) => item.id === accountId && item.session)) throw new ChatGptAccountError("reauth_required");
        const next = { ...current, activeAccountId: accountId };
        await save(next);
        return state(next);
      } finally { lock.close(); }
    },
    async signOut(accountId) {
      if (blocked) throw new ChatGptAccountError("storage_failed");
      if (revoking.has(accountId)) throw new ChatGptAccountError("attempt_in_progress");
      revoking.add(accountId);
      sessionSignals.get(accountId)?.abort();
      const refresh = renewable.get(accountId);
      if (refresh) await refresh.catch(() => undefined);
      sessionSignals.delete(accountId);
      let lock: Awaited<ReturnType<typeof acquire>> | undefined;
      try {
        lock = await acquire();
        const current = await read();
        const saved = current.accounts.find((item) => item.id === accountId);
        if (!saved) throw new ChatGptAccountError("invalid_request");
        if (!saved.session) return { state: state(current), revocation: "not_needed" };
        const next = { ...current, activeAccountId: current.activeAccountId === accountId ? null : current.activeAccountId,
          accounts: current.accounts.map((item) => item.id === accountId ? { ...item, session: null } : item) };
        await save(next);
        const revocation = await oauth.revoke(saved.registration.clientId, saved.session.refreshToken, AbortSignal.timeout(5000))
          .then(() => "confirmed" as const, () => "unconfirmed" as const);
        return { state: state(next), revocation };
      } finally {
        revoking.delete(accountId);
        lock?.close();
      }
    },
  };
}
