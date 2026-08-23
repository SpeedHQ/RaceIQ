import { auth, drive } from "@googleapis/drive";
import { getSecret, setSecret } from "../../runtime/platform/keystore";

const CREDENTIAL_KEY = "google-drive-setup-credentials";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const PENDING_TTL = 10 * 60_000;

type OAuthTokens = { access_token?: string; refresh_token?: string; expiry_date?: number; token_type?: string; scope?: string };
type Credentials = OAuthTokens;
type SecretStore = { get(key: string): Promise<string>; set(key: string, value: string): Promise<unknown> };
export type GoogleDriveAuthDeps = { clientId?: string; port?: string | number; secrets?: SecretStore; oauthFactory?: (id: string, redirect: string) => OAuthClient };

const defaultSecrets: SecretStore = { get: getSecret, set: setSecret };
let deps: Required<Pick<GoogleDriveAuthDeps, "clientId" | "port">> & Omit<GoogleDriveAuthDeps, "clientId" | "port"> = { clientId: process.env.RACEIQ_GOOGLE_DRIVE_CLIENT_ID ?? "", port: process.env.SERVER_PORT || 3117, secrets: defaultSecrets };
let client: OAuthClient | undefined;
let tokenListenerInstalled = false;
let credentialGeneration = 0;
let pending = new Map<string, { codeVerifier: string; expiresAt: number }>();
let writeChain = Promise.resolve();

export function configureGoogleDriveAuth(overrides: GoogleDriveAuthDeps = {}): void { deps = { ...deps, ...overrides, secrets: overrides.secrets ?? deps.secrets ?? defaultSecrets }; client = undefined; tokenListenerInstalled = false; credentialGeneration++; pending.clear(); }
const redirectUri = () => `http://127.0.0.1:${deps.port || 3117}/api/setup-backups/google/callback`;
const oauth = () => client ??= (deps.oauthFactory ?? ((id, redirect) => new auth.OAuth2(id, undefined, redirect)))(deps.clientId, redirectUri());
async function readCredentials(): Promise<Credentials | undefined> { const raw = await (deps.secrets ?? defaultSecrets).get(CREDENTIAL_KEY); if (!raw) return undefined; try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : undefined; } catch { return undefined; } }
function saveCredentials(value: Credentials): Promise<void> { const serialized = JSON.stringify(value); writeChain = writeChain.then(async () => { await (deps.secrets ?? defaultSecrets).set(CREDENTIAL_KEY, serialized); }); return writeChain; }

export type GoogleDriveStatus = "unconfigured" | "disconnected" | "connected" | "unavailable";
export async function status(): Promise<GoogleDriveStatus> {
  if (!deps.clientId) return "unconfigured";
  const credentials = await readCredentials(); if (!credentials?.refresh_token) return "disconnected";
  try { const api = drive({ version: "v3", auth: await getAuthorizedClient() }); await api.files.list({ pageSize: 1, fields: "files(id)" }); return "connected"; }
  catch (error) { const code = (error as { response?: { status?: number }; code?: number }).response?.status ?? (error as { code?: number }).code; if (code === 401) { credentialGeneration++; writeChain = writeChain.then(async () => { await (deps.secrets ?? defaultSecrets).set(CREDENTIAL_KEY, ""); }); await writeChain; return "disconnected"; } return "unavailable"; }
}

export async function beginAuthorization(): Promise<{ url: string; state: string }> {
  if (!deps.clientId) throw new Error("Google Drive is not configured; set RACEIQ_GOOGLE_DRIVE_CLIENT_ID and reconnect.");
  const verifier = await oauth().generateCodeVerifierAsync(); const state = crypto.randomUUID(); pending.set(state, { codeVerifier: verifier.codeVerifier, expiresAt: Date.now() + PENDING_TTL });
  const url = oauth().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [SCOPE], state, code_challenge_method: "S256" as NonNullable<Parameters<OAuthClient["generateAuthUrl"]>[0]>["code_challenge_method"], code_challenge: verifier.codeChallenge }); return { url, state };
}
export async function completeAuthorization(input: { code: string; state: string }): Promise<void> {
  const item = pending.get(input.state); pending.delete(input.state); if (!item || item.expiresAt < Date.now()) throw new Error("Google authorization expired or was already used; reconnect.");
  try { const { tokens } = await oauth().getToken({ code: input.code, codeVerifier: item.codeVerifier }); if (!tokens.refresh_token) throw new Error("Google authorization did not return a refresh token; reconnect."); await saveCredentials(tokens as Credentials); }
  catch (e) { throw new Error(`Google authorization failed; reconnect. ${e instanceof Error ? e.message : ""}`.trim()); }
}
export async function getAuthorizedClient(): Promise<OAuthClient> { const credentials = await readCredentials(); if (!credentials?.refresh_token) throw Object.assign(new Error("Google Drive is disconnected; reconnect."), { code: "drive-disconnected" }); const c = oauth(); c.setCredentials(credentials); if (!tokenListenerInstalled) { tokenListenerInstalled = true; const installGeneration = credentialGeneration; c.on("tokens", (tokens) => { writeChain = writeChain.then(async () => { if (installGeneration !== credentialGeneration) return; const current = await readCredentials(); await (deps.secrets ?? defaultSecrets).set(CREDENTIAL_KEY, JSON.stringify({ ...(current ?? credentials), ...tokens, refresh_token: tokens.refresh_token ?? current?.refresh_token })); }); } ); } return c; }
export async function disconnect(): Promise<void> { const credentials = await readCredentials(); try { if (credentials?.refresh_token) await oauth().revokeToken(credentials.refresh_token); } catch { /* best effort */ } finally { credentialGeneration++; writeChain = writeChain.then(async () => { await (deps.secrets ?? defaultSecrets).set(CREDENTIAL_KEY, ""); }); await writeChain; } }
export { CREDENTIAL_KEY, SCOPE, redirectUri };
export type DriveApi = ReturnType<typeof drive>;
export type OAuthClient = InstanceType<typeof auth.OAuth2>;
