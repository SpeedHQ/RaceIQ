import { describe, expect, it } from "bun:test";
import { buildLiveTelemetryView, indexTelemetrySchema, readIndexedValue } from "../src/lib/live-telemetry-view";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../shared/telemetry/live/contracts";
const schema = { type:"telemetry-schema", protocolVersion:1, schemaId:"s", simulator:"acc", catalogVersion:"c", catalogHash:"h", catalogSchemaVersion:"1", parserVersion:"p", resolverVersion:"r", derivationVersion:"d", definitions:["motion.speed","tires.tire-pressure","timing.lap-fraction"].map(semanticId=>({semanticId,unit:null,mappingStatus:"direct",schemaVersion:"1",limitations:[]})) } as LiveTelemetrySchemaMessageV1;
const frame = (values: unknown[], schemaId="s", states?: Record<number, any>) => ({type:"telemetry-frame",protocolVersion:1,schemaId,streamId:"x",sessionId:null,sequence:1,observedAt:{domain:"session",milliseconds:2},receivedAtMs:3,values,states}) as LiveTelemetryFrameMessageV1;
describe("live telemetry view",()=>{
 it("indexes semantic values and rejects schema mismatch",()=>{const i=indexTelemetrySchema(schema); expect(readIndexedValue(i,frame([4,[1,2,3,4],.5]),"motion.speed")).toBe(4); expect(buildLiveTelemetryView(schema,frame([4,5,6],"other"))).toBeUndefined();});
 it("returns undefined for non-ok values and preserves sparse state",()=>{const f=frame([4,5,.5],"s",{1:"stale"}); const v=buildLiveTelemetryView(schema,f)!; expect(v.motion.speedMps).toBe(4); expect(v.tires.pressurePsi).toBeUndefined(); expect(v.stateBySemanticId["tires.tire-pressure"]).toBe("stale");});
 it("builds scalar view",()=>{const v=buildLiveTelemetryView(schema,frame([12,[1,2,3,4],.25]))!; expect(v.motion.speedMps).toBe(12); expect(v.timing.lapFraction).toBe(.25);});
});
