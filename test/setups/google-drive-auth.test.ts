import { describe, expect, test } from "bun:test";
import { beginAuthorization, configureGoogleDriveAuth, status } from "../../server/integrations/google-drive/auth";

test("reports unconfigured without client id and does not touch credentials", async () => {
  const calls: string[] = [];
  configureGoogleDriveAuth({ clientId: "", secrets: { get: async () => { calls.push("get"); return ""; }, set: async () => calls.push("set") } });
  expect(await status()).toBe("unconfigured");
  expect(calls).toEqual([]);
});

test("creates PKCE authorization URL with drive.file scope", async () => {
  const fake = {
    generateCodeVerifierAsync: async () => ({ codeVerifier: "verifier", codeChallenge: "challenge" }),
    generateAuthUrl: (opts: Record<string, unknown>) => { expect(opts.scope).toEqual(["https://www.googleapis.com/auth/drive.file"]); expect(opts.code_challenge_method).toBe("S256"); return "https://accounts.google.test/oauth"; },
  } as never;
  configureGoogleDriveAuth({ clientId: "client", oauthFactory: () => fake });
  expect((await beginAuthorization()).url).toBe("https://accounts.google.test/oauth");
});
