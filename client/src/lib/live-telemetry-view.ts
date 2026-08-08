import type { GameId } from "../../../shared/games/ids";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../../shared/telemetry/live/contracts";
import type { ResolutionState } from "../../../shared/telemetry/resolver/contracts";

export type WheelValues<T> = Readonly<{ fl: T; fr: T; rl: T; rr: T }>;
export interface LiveCompetitorView { position?: number; name?: string; gapToAheadS?: number; gapToLeaderS?: number; tireCompound?: string | number; tireAge?: number; pitStatus?: number | boolean; pitStops?: number; lastS1S?: number; lastS2S?: number; lastS3S?: number; }
export interface LiveF1Extension {
  drsAllowed?: boolean; drsActivated?: boolean; ersStoreEnergy?: number; ersDeployMode?: number;
  ersDeployedThisLap?: number; ersHarvestedThisLap?: number; weather?: number; rainPercentage?: number;
  trackTemperature?: number; airTemperature?: number; totalLaps?: number; sessionType?: number | string;
  frontLeftWingDamage?: number; frontRightWingDamage?: number; rearWingDamage?: number;
  floorDamage?: number; diffuserDamage?: number; sidepodDamage?: number;
}
export interface LiveTelemetryView {
 simulator: GameId; streamId: string; sessionId: number | null; sequence: number; observedAtMs: number;
 identity: { carOrdinal?: number; trackOrdinal?: number; carClass?: number; performanceIndex?: number; drivetrainType?: number };
 motion: { speedMps?: number; acceleration?: { x:number; z:number }; position?: { x:number; z:number }; attitude?: { roll:number; pitch:number; yaw:number }; distanceM?: number };
 inputs: { throttle?:number; brake?:number; steer?:number; gear?:number };
 engine: { rpm?:number; idleRpm?:number; maxRpm?:number; powerW?:number; torqueNm?:number; boost?:number };
 fuel: { amount?:number; capacity?:number };
 timing: { lapNumber?:number; currentLapS?:number; lastLapS?:number; bestLapS?:number; totalLaps?:number; lapFraction?:number; racePosition?:number };
 tires: { temperatureC?:WheelValues<number>; wear?:WheelValues<number>; pressurePsi?:WheelValues<number>; slipAngleRad?:WheelValues<number>; slipRatio?:WheelValues<number>; combinedSlip?:WheelValues<number>; rotationRadS?:WheelValues<number>; suspensionNormalized?:WheelValues<number>; brakeTemperatureC?:WheelValues<number>; brakePadRemainingMm?:WheelValues<number>; radiusM?:WheelValues<number>; surfaceRumble?:WheelValues<number>; puddleDepth?:WheelValues<number>; onRumbleStrip?:WheelValues<number>; compound?:string|number };
 weather:{kind?:number; airTemperatureC?:number; trackTemperatureC?:number; rainPercent?:number}; aero:{drsActive?:boolean; drsAvailable?:boolean}; ers:{storeJ?:number; deployMode?:number; deployedThisLapJ?:number; harvestedThisLapJ?:number};
 damage:{frontLeftWingPct?:number; frontRightWingPct?:number; rearWingPct?:number; floorPct?:number; diffuserPct?:number; sidepodPct?:number}; competitors: readonly LiveCompetitorView[]; f1?: LiveF1Extension; stateBySemanticId: Readonly<Record<string, ResolutionState>>;
}

type Indexed = { schema: LiveTelemetrySchemaMessageV1; indexes: Map<string, number> };
export function indexTelemetrySchema(schema: LiveTelemetrySchemaMessageV1): Indexed { return {schema,indexes:new Map(schema.definitions.map((d,i)=>[d.semanticId,i]))}; }
export function readIndexedValue(indexed: Indexed, frame: LiveTelemetryFrameMessageV1, semanticId: string): unknown { if (frame.schemaId !== indexed.schema.schemaId) return undefined; const i=indexed.indexes.get(semanticId); if (i===undefined) return undefined; const state = frame.states?.[i] as string | undefined; const freshness = frame.freshness?.[i] as string | undefined; if (state && state !== "ok") return undefined; if (freshness && freshness !== "fresh") return undefined; return frame.values[i]; }
export function buildLiveTelemetryView(schema: LiveTelemetrySchemaMessageV1, frame: LiveTelemetryFrameMessageV1): LiveTelemetryView | undefined {
 const indexed=indexTelemetrySchema(schema); if(frame.schemaId!==schema.schemaId) return undefined; const r=(id:string)=>readIndexedValue(indexed,frame,id);
 const w=(base:string)=>{const value=r(base); return Array.isArray(value)&&value.length>=4&&value.slice(0,4).every(x=>typeof x==="number") ? {fl:value[0] as number,fr:value[1] as number,rl:value[2] as number,rr:value[3] as number} : undefined;};
 const grouped:any={identity:{},motion:{},inputs:{},engine:{},fuel:{},timing:{},tires:{},weather:{},aero:{},ers:{},damage:{},competitors:[],stateBySemanticId:{}};
 const put=(obj:any,key:string,id:string)=>{const v=r(id); if(v!==undefined)obj[key]=v};
 [[grouped.identity,"carOrdinal","identity.car-ordinal"],[grouped.identity,"trackOrdinal","identity.track-ordinal"],[grouped.identity,"carClass","identity.car-class"],[grouped.identity,"performanceIndex","identity.car-performance-index"],[grouped.identity,"drivetrainType","identity.drivetrain-type"],[grouped.motion,"speedMps","motion.speed"],[grouped.motion,"distanceM","timing.distance-traveled"],[grouped.motion,"accelerationX","motion.acceleration-x"],[grouped.motion,"accelerationZ","motion.acceleration-z"],[grouped.inputs,"throttle","inputs.accel"],[grouped.inputs,"brake","inputs.brake"],[grouped.inputs,"steer","inputs.steer"],[grouped.inputs,"gear","inputs.gear"],[grouped.engine,"rpm","engine.current-engine-rpm"],[grouped.engine,"idleRpm","engine.engine-idle-rpm"],[grouped.engine,"maxRpm","engine.engine-max-rpm"],[grouped.engine,"powerW","engine.power"],[grouped.engine,"torqueNm","engine.torque"],[grouped.engine,"boost","engine.boost"],[grouped.fuel,"amount","fuel.fuel"],[grouped.fuel,"capacity","fuel.fuel-capacity"],[grouped.timing,"lapNumber","timing.lap-number"],[grouped.timing,"currentLapS","timing.current-lap"],[grouped.timing,"lastLapS","timing.last-lap"],[grouped.timing,"bestLapS","timing.best-lap"],[grouped.timing,"racePosition","race.race-position"],[grouped.weather,"kind","weather.weather-type"],[grouped.weather,"airTemperatureC","weather.air-temp"],[grouped.weather,"trackTemperatureC","weather.track-temp"],[grouped.motion,"distanceM","timing.distance-traveled"]].forEach(([o,k,id])=>put(o,k,id));
 if (grouped.motion.accelerationX !== undefined || grouped.motion.accelerationZ !== undefined) grouped.motion.acceleration={x:grouped.motion.accelerationX ?? 0,z:grouped.motion.accelerationZ ?? 0};
 ([ ["temperatureC","tires.tire-temperature"],["wear","tires.tire-wear"],["pressurePsi","tires.tire-pressure"],["slipAngleRad","tires.tire-slip-angle"],["slipRatio","tires.tire-slip-ratio"],["combinedSlip","tires.tire-combined-slip"],["rotationRadS","tires.wheel-rotation-speed"],["suspensionNormalized","suspension.norm-suspension-travel"],["brakeTemperatureC","brakes.brake-temp"],["brakePadRemainingMm","damage.brake-pad-wear"],["radiusM","tires.tire-radius"],["surfaceRumble","tires.surface-rumble"],["puddleDepth","tires.wheel-in-puddle-depth"],["onRumbleStrip","tires.wheel-on-rumble-strip"]] as const).forEach(([k,id])=>{const v=w(id);if(v)grouped.tires[k]=v;});
 const competitorFields: [string,string][] = [["position","race.competitor.position"],["name","race.competitor.driver-name"],["gapToAheadS","timing.competitor.gap-to-ahead"],["gapToLeaderS","timing.competitor.gap-to-leader"],["tireCompound","tires.competitor.compound"],["tireAge","tires.competitor.age"],["pitStatus","race.competitor.pit-status"],["pitStops","race.competitor.pit-stops"],["lastS1S","timing.sector.competitor-last.s1"],["lastS2S","timing.sector.competitor-last.s2"],["lastS3S","timing.sector.competitor-last.s3"]];
 const competitorArrays=competitorFields.map(([key,id])=>[key,r(id)] as const); const competitorLength=Math.max(0,...competitorArrays.map(([,v])=>Array.isArray(v)?v.length:0));
 for(let i=0;i<competitorLength;i++){const item:LiveCompetitorView={}; for(const [key,value] of competitorArrays) if(Array.isArray(value)&&value[i]!==undefined) (item as Record<string,unknown>)[key]=value[i]; grouped.competitors.push(item);}
 const f1: LiveF1Extension = {};
 const f1Put=(key:keyof LiveF1Extension, id:string)=>{const v=r(id); if(v!==undefined) f1[key]=v as never;};
 ([
   ["drsAllowed","aero.drs-available"],["drsActivated","aero.drs-active"],["ersStoreEnergy","fuel.ers-store-energy"],
   ["ersDeployMode","fuel.ers-deploy-mode"],["ersDeployedThisLap","fuel.ers-deployed"],["ersHarvestedThisLap","fuel.ers-harvested"],
   ["weather","weather.weather-type"],["rainPercentage","weather.rain-percent"],["trackTemperature","weather.track-temp"],
   ["airTemperature","weather.air-temp"],["totalLaps","timing.total-laps"],["sessionType","session.session-type"],
   ["frontLeftWingDamage","damage.front-left-wing-damage"],["frontRightWingDamage","damage.front-right-wing-damage"],
   ["rearWingDamage","damage.rear-wing-damage"],["floorDamage","damage.floor-damage"],["diffuserDamage","damage.diffuser-damage"],
   ["sidepodDamage","damage.sidepod-damage"],
 ] as const).forEach(([key,id])=>f1Put(key,id));
 for(const [id,state] of Object.entries(frame.states??{})) { const i=Number(id); const semantic=schema.definitions[i]?.semanticId; if(semantic) grouped.stateBySemanticId[semantic]=state; }
 return {simulator:schema.simulator,streamId:frame.streamId,sessionId:frame.sessionId,sequence:frame.sequence,observedAtMs:frame.observedAt.milliseconds,...grouped,...(schema.simulator==="f1-2025" ? {f1} : {})};
}
