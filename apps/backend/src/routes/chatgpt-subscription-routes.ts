import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  ChatGptAccountError,
  CHATGPT_SUBSCRIPTION_ERROR_STATUS,
  type ChatGptConnectResult,
  type ChatGptSignOutResult,
  type ChatGptSubscriptionState,
} from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import type { CodexUsage } from "@raceiq/assistant/ai/codex-usage";

const path = "/api/auth/chatgpt-subscription";
const accountId = z.string().min(1).max(128);
const connectBody = z.strictObject({ accountId: accountId.nullable() });
const activeBody = z.strictObject({ accountId });
const invalidRequest = { code: "invalid_request", error: "Invalid ChatGPT account request." } as const;
const unavailableState: ChatGptSubscriptionState = {
  availability: "unavailable", activeAccountId: null, accounts: [], attempt: null,
};

export interface ChatGptAccountService {
  state(): Promise<ChatGptSubscriptionState>;
  connect(accountId: string | null): Promise<ChatGptConnectResult>;
  cancel(attemptId: string): Promise<void>;
  activate(accountId: string): Promise<ChatGptSubscriptionState>;
  signOut(accountId: string): Promise<ChatGptSignOutResult>;
}

export function createChatGptSubscriptionRoutes({ authorize, isTrustedLocal, service, codexUsage }: {
  authorize(request: Request): Promise<Response | undefined>;
  isTrustedLocal(request: Request, requireOrigin: boolean): boolean;
  service: ChatGptAccountService | null;
  codexUsage?: () => Promise<CodexUsage>;
}) {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof HTTPException && error.status === 400) return c.json(invalidRequest, 400, { "Cache-Control": "no-store" });
      const code = error instanceof ChatGptAccountError ? error.code : "upstream_unavailable";
      return c.json({ code, error: code }, CHATGPT_SUBSCRIPTION_ERROR_STATUS[code], { "Cache-Control": "no-store" });
    })
    .use(`${path}/*`, async (c, next) => {
      c.header("Cache-Control", "no-store");
      const req = c.req.raw;
      const mutation = req.method !== "GET";
      const url = new URL(req.url);
      if (!isTrustedLocal(req, mutation) || req.headers.get("Host") !== url.host) {
        return c.json({ code: "forbidden", error: "Use a local RaceIQ session." }, 403);
      }
      const denied = await authorize(req);
      if (denied) {
        const response = new Response(denied.body, denied);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
      if (mutation && !service) return c.json({ code: "unavailable", error: "ChatGPT sign-in is unavailable." }, 503);
      await next();
    })
    .get(path, async (c) => c.json(service ? await service.state() : unavailableState))
    .post(`${path}/codex-usage`, async (c) => codexUsage
      ? c.json(await codexUsage())
      : c.json({ code: "unavailable", error: "Codex usage is unavailable." }, 503))
    .post(`${path}/connect`, zValidator("json", connectBody, (result, c) => {
      if (!result.success) return c.json(invalidRequest, 400);
    }), async (c) => c.json(await service!.connect(c.req.valid("json").accountId), 201))
    .delete(`${path}/connect/:attemptId`, async (c) => {
      const attempt = accountId.safeParse(c.req.param("attemptId"));
      if (!attempt.success) return c.json(invalidRequest, 400);
      await service!.cancel(attempt.data);
      return c.body(null, 204);
    })
    .put(`${path}/active`, zValidator("json", activeBody, (result, c) => {
      if (!result.success) return c.json(invalidRequest, 400);
    }), async (c) => c.json(await service!.activate(c.req.valid("json").accountId)))
    .delete(`${path}/accounts/:accountId/session`, async (c) => {
      const account = accountId.safeParse(c.req.param("accountId"));
      if (!account.success) return c.json(invalidRequest, 400);
      return c.json(await service!.signOut(account.data));
    });
}
