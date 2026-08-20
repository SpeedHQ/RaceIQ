import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { beginAuthorization, completeAuthorization, disconnect, status } from "../integrations/google-drive/auth";
import { createSetupBackupStore } from "../integrations/google-drive/setup-backup-store";
import { createBackupService, type BackupService } from "../setups/backup-service";
import { SetupConflictPolicySchema } from "../../shared/racing/setups/backup";

const game = z.enum(["acc", "ac-evo"]); const policy = SetupConflictPolicySchema;
export type SetupBackupRouteDeps = { service?: BackupService; auth?: { status: typeof status; beginAuthorization: typeof beginAuthorization; completeAuthorization: typeof completeAuthorization; disconnect: typeof disconnect } };
const stableMessages: Record<string, string> = {
  "drive-not-configured": "Google Drive is not configured.",
  "drive-disconnected": "Google Drive is disconnected.",
  "drive-unavailable": "Google Drive is temporarily unavailable.",
  "setup-folder-missing": "The game's setup folder was not found.",
  "local-setup-not-found": "Local setup file was not found.",
  "backup-not-found": "Google Drive backup not found.",
  "duplicate-name": "A backup with this name already exists.",
  "invalid-name": "Setup name is invalid.",
  "invalid-archive": "Backup archive is damaged.",
  "invalid-manifest": "Backup manifest is invalid.",
  "unsupported-schema": "Backup schema is unsupported.",
  "unsupported-format": "Backup format is unsupported.",
  "binding-mismatch": "Backup binding does not match requested game.",
};
function errorResponse(error: unknown, c: Context) {
  const rawCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const rawMessage = error instanceof Error ? error.message : "";
  const inferredCode = rawCode ?? (rawMessage.includes("not configured") ? "drive-not-configured" : rawMessage.includes("disconnected") ? "drive-disconnected" : undefined);
  const code = inferredCode && inferredCode in stableMessages ? inferredCode : "drive-unavailable";
  const message = stableMessages[code]!;
  const statusCode = code === "duplicate-name" ? 409 : code === "backup-not-found" ? 404 : code === "drive-unavailable" ? 503 : code === "binding-mismatch" ? 409 : code === "drive-not-configured" || code === "drive-disconnected" ? 409 : 400;
  return c.json({ error: message, code }, statusCode as 400);
}
const defaultAuth = { status, beginAuthorization, completeAuthorization, disconnect };
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]!)); }
function html(message: string) { return `<!doctype html><meta charset="utf-8"><title>Google Drive</title><p>${escapeHtml(message)}</p><script>window.close()</script>`; }
const defaultDeps = { auth: defaultAuth };
export function createSetupBackupRoutes(input: SetupBackupRouteDeps = {}) {
  const deps = { ...defaultDeps, auth: { ...defaultDeps.auth, ...input.auth } };
  let service = input.service;
  const getService = () => service ??= createBackupService({ store: createSetupBackupStore() });
  const app = new Hono();
  app.get("/api/setup-backups/google/status", async c => c.json({ status: await deps.auth.status() }));
  app.delete("/api/setup-backups/google/connection", async c => { try { await deps.auth.disconnect(); return c.json({ disconnected: true }); } catch (error) { return errorResponse(error, c); } });
  app.get("/api/setup-backups/google/connect", async c => { try { const result = await deps.auth.beginAuthorization(); return c.redirect(result.url, 302); } catch (error) { return errorResponse(error, c); } });
  app.get("/api/setup-backups/google/callback", async c => { try { const code = c.req.query("code"); const state = c.req.query("state"); if (!code || !state) throw new Error("authorization failed"); await deps.auth.completeAuthorization({ code, state }); return c.html(html("Authorization complete. You can close this window.")); } catch { return c.html(html("Authorization failed. You can close this window."), 400); } });
  app.get("/api/setup-backups", async c => { const parsed = game.safeParse(c.req.query("gameId")); if (!parsed.success) return c.json({ error: "Invalid gameId", code: "invalid-name" }, 400); try { return c.json({ backups: await getService().listBackups(parsed.data) }); } catch (e) { return errorResponse(e, c); } });
  app.post("/api/setup-backups", async c => { try { const body = await c.req.json(); const parsed = z.object({ gameId: game, localPath: z.string().min(1), conflict: policy.default("error") }).parse(body); return c.json(await getService().backupLocalSetup(parsed)); } catch (e) { return errorResponse(e, c); } });
  app.patch("/api/setup-backups/:backupId", async c => { try { const body = await c.req.json(); const parsed = z.object({ gameId: game, name: z.string().min(1), conflict: policy.default("error") }).parse(body); return c.json(await getService().renameBackup({ ...parsed, backupId: c.req.param("backupId") })); } catch (e) { return errorResponse(e, c); } });
  app.post("/api/setup-backups/:backupId/restore", async c => { try { const body = await c.req.json(); const parsed = z.object({ gameId: game, conflict: policy.default("error") }).parse(body); return c.json(await getService().restoreBackup({ ...parsed, backupId: c.req.param("backupId") })); } catch (e) { return errorResponse(e, c); } });
  app.delete("/api/setup-backups/:backupId", async c => { const parsed = game.safeParse(c.req.query("gameId")); if (!parsed.success) return c.json({ error: "Invalid gameId", code: "invalid-name" }, 400); try { return c.json(await getService().deleteBackup({ gameId: parsed.data, backupId: c.req.param("backupId") })); } catch (e) { return errorResponse(e, c); } });
  return app;
}
export const setupBackupRoutes = createSetupBackupRoutes();
