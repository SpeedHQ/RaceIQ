import { Hono,type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { IDLE_CLOUD_LAP_IMPORT,type CloudLapImportState } from "@raceiq/shared/integrations/cloud-lap-import";
import { getOnlineService } from "../integrations/online";
import { cloudImportStart,cloudImportQuery,cloudImportActivation } from "../integrations/online-import-contract";

async function proxy(c:Context,path:string,method:"GET"|"POST",body:string|null,query:string|null=null){
  try{
    const result=await getOnlineService().importRequest({path,method,body,query,gameId:c.req.header("X-Game-Id")??null});
    c.header("Cache-Control","no-store");
    return c.json(result.body,result.status);
  }catch{return c.json({...IDLE_CLOUD_LAP_IMPORT,status:"error",error:{code:"service_unavailable",retryable:true}} satisfies CloudLapImportState,503);}
}
export const cloudLapImportRoutes=new Hono()
  .get("/api/online/lap-import",zValidator("query",cloudImportQuery),c=>{
    const input=c.req.valid("query");
    return proxy(c,"/api/online/lap-import","GET",null,new URLSearchParams({accountEpoch:input.accountEpoch,expectedRevision:String(input.expectedRevision)}).toString());
  })
  .post("/api/online/lap-import",zValidator("json",cloudImportStart),c=>proxy(c,"/api/online/lap-import","POST",JSON.stringify(c.req.valid("json"))))
  .post("/api/online/lap-import/retry",zValidator("json",cloudImportActivation),c=>proxy(c,"/api/online/lap-import/retry","POST",JSON.stringify(c.req.valid("json"))))
  .post("/api/online/lap-import/ack",zValidator("json",cloudImportActivation),c=>proxy(c,"/api/online/lap-import/ack","POST",JSON.stringify(c.req.valid("json"))));
export function dispatchCloudLapImport(url:string):Promise<CloudLapImportState>{return getOnlineService().dispatchCloudLapImport(url);}
