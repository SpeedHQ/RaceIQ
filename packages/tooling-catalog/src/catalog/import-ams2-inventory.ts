import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { ams2IdentityId } from "@raceiq/game-ams2-metadata/identity";

interface Vehicle { id: number; name: string; class?: string }
interface Track { id: number; name: string; gridsize: number }
interface Override { name?: string; commonTrackName?: string; telemetryName?: string; nativeLengthM?: number; geometryLayout?: string }

/** Offline conversion only: never fetch catalogs or rewrite user identities at runtime. */
export function convertAMS2Inventory(vehicles: Vehicle[], tracks: Track[], overrides: Record<string, Override>, geometry: Array<{layout: string; lengthM: number}>) {
  const cars = new Map<string, {id: string; name: string; classes: string[]; serverIds: number[]}>();
  const seenVehicleIds = new Set<number>();
  for (const vehicle of vehicles) {
    if (!Number.isInteger(vehicle.id) || !vehicle.name?.trim() || seenVehicleIds.has(vehicle.id)) throw new Error("Invalid or duplicate AMS2 server vehicle ID");
    seenVehicleIds.add(vehicle.id);
    const id = ams2IdentityId(vehicle.name);
    const car = cars.get(id) ?? {id, name: vehicle.name, classes: [], serverIds: []};
    if (car.name !== vehicle.name) throw new Error(`AMS2 car hash collision: ${car.name} / ${vehicle.name}`);
    if (vehicle.class && !car.classes.includes(vehicle.class)) car.classes.push(vehicle.class);
    car.serverIds.push(vehicle.id);
    cars.set(id, car);
  }
  const ids = new Set<string>(), layouts = new Set<string>();
  const catalogTracks = tracks.map(track => {
    if (!Number.isInteger(track.id) || !track.name?.trim() || !Number.isInteger(track.gridsize) || layouts.has(track.name.toLowerCase())) throw new Error("Invalid or duplicate AMS2 layout");
    layouts.add(track.name.toLowerCase());
    const override = overrides[track.name] ?? {};
    const id = override.telemetryName ? ams2IdentityId(override.telemetryName) : String(track.id);
    if (ids.has(id)) throw new Error(`AMS2 track ID collision: ${id}`);
    ids.add(id);
    const matches = geometry.filter(entry => entry.layout.toLowerCase() === (override.geometryLayout ?? track.name).toLowerCase());
    if(matches.length > 1) throw new Error(`Ambiguous AMS2 geometry: ${track.name}`);
    return {id, serverId: track.id, layout: track.name, telemetryName: override.telemetryName ?? null,
      name: override.name ?? track.name.replaceAll("_", " "), variant: track.name,
      nativeLengthM: override.nativeLengthM ?? null,
      lengthM: override.nativeLengthM ?? matches[0]?.lengthM ?? null,
      geometryLayout: matches[0]?.layout ?? null, commonTrackName: override.commonTrackName ?? null, gridSize: track.gridsize};
  });
  for (const layout of Object.keys(overrides)) if (!layouts.has(layout.toLowerCase())) throw new Error(`Override missing from source: ${layout}`);
  return {cars: [...cars.values()].sort((a,b) => a.name.localeCompare(b.name)), tracks: catalogTracks.sort((a,b) => a.layout.localeCompare(b.layout))};
}

if (import.meta.main) {
  const sourceDir=process.argv[2];
  if(!sourceDir) throw new Error("Usage: bun packages/tooling-catalog/src/catalog/import-ams2-inventory.ts <snapshot-directory>");
  const root=resolve(import.meta.dir,"../../../..");
  const output=resolve(root,"packages/game-ams2-metadata/src");
  const source=JSON.parse(readFileSync(resolve(sourceDir,"sources.json"),"utf8"));
  if(!/^[a-f0-9]{40}$/.test(source.revision)) throw new Error("Catalog source revision must be pinned");
  for(const name of ["vehicles.json","tracks.json","vehicle_classes.json"]) {
    const expected=source.sources.find((entry: {file:string;sha256:string})=>entry.file===name)?.sha256;
    const actual=createHash("sha256").update(readFileSync(resolve(sourceDir,name))).digest("hex");
    if(expected !== actual) throw new Error(`Catalog source checksum mismatch: ${name}`);
  }
  const vehicleList=JSON.parse(readFileSync(resolve(sourceDir,"vehicles.json"),"utf8")).response.list;
  const trackList=JSON.parse(readFileSync(resolve(sourceDir,"tracks.json"),"utf8")).response.list;
  const overrides=JSON.parse(readFileSync(resolve(output,"catalog-overrides.json"),"utf8"));
  const geometry=JSON.parse(readFileSync(resolve(root,"packages/game-ams2/assets/tracks/catalog.json"),"utf8")).layouts;
  const result=convertAMS2Inventory(vehicleList,trackList,overrides,geometry);
  for(const track of result.tracks) if(track.commonTrackName && !existsSync(resolve(root,`shared/data/tracks/meta/${track.commonTrackName}.json`))) throw new Error(`Missing common track facts: ${track.commonTrackName}`);
  for(const [file,data] of [["cars.json",result.cars],["tracks.json",result.tracks],["catalog-source.json",{...source,coverage:{serverVehicles:vehicleList.length,cars:result.cars.length,tracks:result.tracks.length,geometryMatches:result.tracks.filter(t=>t.geometryLayout).length,commonMappings:result.tracks.filter(t=>t.commonTrackName).length}}]] as const) writeFileSync(resolve(output,file),JSON.stringify(data,null,2)+"\n");
  const fields=["id","serverId","layout","telemetryName","name","variant","nativeLengthM","lengthM","geometryLayout","commonTrackName","gridSize"] as const;
  const csv=(value: unknown) => `"${String(value ?? "").replaceAll('"','""')}"`;
  writeFileSync(resolve(output,"tracks.csv"),fields.join(",")+"\n"+result.tracks.map(track=>fields.map(field=>csv(track[field])).join(",")).join("\n")+"\n");
  console.log(JSON.stringify({cars:result.cars.length,tracks:result.tracks.length,geometryMatches:result.tracks.filter(t=>t.geometryLayout).length,commonMappings:result.tracks.filter(t=>t.commonTrackName).length}));
}
