import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import { validateDashboardRequest } from "@raceiq/shared/racing/sessions/dashboard";
import type { OnlineWorkerPort } from "./worker-protocol";
import { onlineErrorStatus } from "./errors";

const id=z.string().min(1).max(512);
const revision=z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const queryContext=z.object({accountEpoch:id,expectedRevision:revision}).strict();
const bindingInput=z.object({accountEpoch:id,expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),candidateId:id,confirmedByUser:z.literal(true)}).strict();
const uploads=queryContext.extend({view:z.enum(["queue","history"]),cursor:z.string().min(1).max(2048).optional(),limit:z.coerce.number().int().min(1).max(100).default(50)});
const period=z.object({from:z.string(),to:z.string()}).strict();

export function createOnlineDataRoutes(port:OnlineWorkerPort) {
  return new Hono()
    .get("/api/driver-bindings",async c=>c.json(await port.getDriverBindings()))
    .put("/api/driver-bindings",zValidator("json",bindingInput),async c=>{
      const result=await port.setDriverBinding(c.req.valid("json"));
      return c.json(result,result.ok?200:onlineErrorStatus(result.error.code));
    })
    .get("/api/online/uploads",zValidator("query",uploads),async c=>{
      const input=c.req.valid("query");
      return c.json(await port.getUploads({...input,cursor:input.cursor??null}));
    })
    .get("/api/driver-summary",zValidator("query",period),async c=>{
      const parsed=GameIdSchema.optional().safeParse(c.req.header("X-Game-Id"));
      const query=c.req.valid("query");
      if(!parsed.success||!validateDashboardRequest({...query,gameId:parsed.data})) return c.json({error:{code:"invalid_request" as const,retryable:false,retryAfter:null}},400);
      try { return c.json(await port.getLocalSummary({...query,gameId:parsed.data})); }
      catch(cause) {
        if(cause instanceof Error&&"code"in cause&&cause.code==="building") return c.json({status:"building" as const},202);
        return c.json({error:{code:"service_unavailable" as const,retryable:true,retryAfter:null}},503);
      }
    })
    .get("/api/online/profile",zValidator("query",queryContext),async c=>{
      const input=c.req.valid("query"),state=await port.getState();
      if(input.accountEpoch!==state.accountEpoch||input.expectedRevision!==state.revision) return c.json({error:{code:"stale_state" as const,retryable:false,retryAfter:null}},409);
      const profile=await port.getOnlineProfile();
      const current=await port.getState();
      if(current.accountEpoch!==state.accountEpoch||current.revision!==state.revision) return c.json({error:{code:"stale_state" as const,retryable:false,retryAfter:null}},409);
      return c.json(profile,profile.status==="unavailable"?503:200);
    });
}
