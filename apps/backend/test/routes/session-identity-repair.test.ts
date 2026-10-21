import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { discoveredCars, discoveredTracks, laps, sessions } from "@raceiq/backend-core/db/schema";
import { ImportCaptureAdapter } from "@raceiq/backend-core/session-capture/import-pipeline";
import { getDiscoveredCarName } from "@raceiq/backend-core/db/discovered-cars";
import { getDiscoveredTrackName } from "@raceiq/backend-core/db/discovered-tracks";
import { fmCarCatalog } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";
import { fmTrackCatalog } from "@raceiq/game-fm-2023-metadata/racing/tracks/catalogs/fm";
import { sessionRoutes } from "../../src/routes/session-routes";
import { carRoutes } from "../../src/routes/car-routes";
import { trackRoutes } from "../../src/routes/tracks/index";
import { ams2Adapter, registerAMS2Identity, ams2TrackCatalog } from "@raceiq/game-ams2-metadata/index";
import { ams2IdentityId } from "@raceiq/game-ams2-metadata/identity";
import { isSessionIdentityInCatalog } from "../../src/games/session-identity";

const sessionIds: number[] = [];
const tempDirs: string[] = [];
const discoveredCarIds: string[] = [];
const discoveredTrackIds: string[] = [];

afterEach(async () => {
  for (const sessionId of sessionIds.splice(0)) {
    await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  for(const id of discoveredCarIds.splice(0)) await db.delete(discoveredCars).where(eq(discoveredCars.carId,id)).run();
  for(const id of discoveredTrackIds.splice(0)) await db.delete(discoveredTracks).where(eq(discoveredTracks.trackId,id)).run();
});

describe("session identity repair", () => {
  test("AMS2 import discovery survives a fresh process and preserves recorded IDs without duplicate layouts", async () => {
    const carName="Import-only AMS2 test car", trackName="Donington - Donington_GP";
    const carId=ams2IdentityId(carName), trackId=ams2IdentityId(trackName);
    discoveredCarIds.push(carId); discoveredTrackIds.push(trackId);
    registerAMS2Identity(carId,carName,trackId,trackName);
    const adapter=new ImportCaptureAdapter({notifyDriverProfile:false});
    const sessionId=await adapter.insertSession(carId,trackId,"ams2","practice");
    sessionIds.push(sessionId);
    expect(await getDiscoveredCarName("ams2",carId)).toBe(carName);
    expect(await getDiscoveredTrackName("ams2",trackId)).toBe(trackName);
    const rows=await (await trackRoutes.request("/api/tracks?gameId=ams2")).json() as Array<{id:string;commonTrackName:string}>;
    const official=ams2TrackCatalog.find(track=>track.layout==="Donington_GP")!;
    expect(rows.some(track=>track.id===trackId && track.commonTrackName==="donington")).toBe(true);
    expect(rows.some(track=>track.id===official.id)).toBe(false);
    const child=Bun.spawn([process.execPath,"--eval",`
      import {initDb,client} from "./server/db/index.ts";
      import {listDiscoveredCars} from "./server/db/discovered-cars.ts";
      import {listDiscoveredTracks} from "./server/db/discovered-tracks.ts";
      import {injectDiscoveredAMS2Identity,ams2Adapter} from "./packages/game-ams2-metadata/src/index.ts";
      await initDb();
      injectDiscoveredAMS2Identity(await listDiscoveredCars("ams2"),await listDiscoveredTracks("ams2"));
      console.log(JSON.stringify({car:ams2Adapter.getCarName(${JSON.stringify(carId)}),track:ams2Adapter.getTrackName(${JSON.stringify(trackId)}),shared:ams2Adapter.getSharedTrackName(${JSON.stringify(trackId)})}));
      client.close();
    `],{cwd:resolve(import.meta.dir,"../../../.."),env:process.env,stdout:"pipe",stderr:"pipe"});
    const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(exit,stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({car:carName,track:"Donington Grand Prix",shared:"donington"});
  });

  test("AMS2 seed identities resolve without a prior live discovery and expose native track edges", async () => {
    const carId = "325487790";
    const trackId = "165370945";
    const carResponse = await carRoutes.request("/api/cars", { headers: { "X-Game-Id": "ams2" } });
    expect(carResponse.status).toBe(200);
    const cars = await carResponse.json() as Array<{ id: string; name: string }>;
    expect(cars.filter(car => car.id === carId)).toEqual([expect.objectContaining({ name: "Volkswagen Polo" })]);
    expect(cars.find(car => car.id === "854916192")?.name).toBe("Porsche 911 GT3 R");
    expect((await carRoutes.request(`/api/cars/${carId}`, { headers: { "X-Game-Id": "ams2" } })).status).toBe(200);

    const trackResponse = await trackRoutes.request("/api/tracks?gameId=ams2");
    expect(trackResponse.status).toBe(200);
    const tracks = await trackResponse.json() as Array<{ id: string; name: string; hasMap: boolean; commonTrackName: string }>;
    expect(tracks.filter(track => track.id === trackId)).toEqual([expect.objectContaining({
      name: "Brands Hatch Indy", hasMap: true, commonTrackName: "brands-hatch-indy",
    })]);
    expect(isSessionIdentityInCatalog("ams2", carId, trackId)).toBe(true);
    expect(isSessionIdentityInCatalog("ams2", "unknown", trackId)).toBe(false);
    expect(isSessionIdentityInCatalog("ams2", carId, "unknown")).toBe(false);
    expect(ams2Adapter.getSharedTrackName?.(trackId)).toBe("brands-hatch-indy");
    const response = await trackRoutes.request(`/api/track-boundaries/${trackId}?gameId=ams2`);
    expect(response.status).toBe(200);
    const boundaries = await response.json() as { coordSystem: string; leftEdge: unknown[]; rightEdge: unknown[]; centerLine: unknown[] };
    expect(boundaries.coordSystem).toBe("ams2-world");
    expect(boundaries.leftEdge).toHaveLength(379);
    expect(boundaries.rightEdge).toHaveLength(379);
    expect(boundaries.centerLine[0]).toEqual({ x: 29.7044, z: 14.4233 });

    const inserted = await db.insert(sessions).values({ gameId: "ams2", carId: "old", trackId: "old" })
      .returning({ id: sessions.id }).get();
    sessionIds.push(inserted!.id);
    const repair = await sessionRoutes.request(`/api/sessions/${inserted!.id}/identity`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "ams2", carId, trackId }),
    });
    expect(repair.status).toBe(200);
  });

  test("updates only canonical session identity and preserves source bytes and lap metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raceiq-session-identity-"));
    tempDirs.push(dir);
    const sourcePath = join(dir, "original.ldx");
    const sourceBytes = Buffer.from([0, 1, 2, 10, 13, 255]);
    await writeFile(sourcePath, sourceBytes);
    const inserted = await db.insert(sessions).values({
      gameId: "fm-2023",
      carId: "unresolved-car",
      trackId: "unresolved-track",
      source: "motec",
      rawFile: sourcePath,
      notes: "session notes",
    }).returning({ id: sessions.id }).get();
    const sessionId = inserted!.id;
    sessionIds.push(sessionId);
    const lap = await db.insert(laps).values({ sessionId, lapNumber: 7, lapTime: 91.25, isValid: true, notes: "lap note" })
      .returning({ id: laps.id }).get();
    const carId = String(fmCarCatalog.keys().next().value);
    const trackId = String(fmTrackCatalog.keys().next().value);

    const response = await sessionRoutes.request(`/api/sessions/${sessionId}/identity`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "fm-2023", carId, trackId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sessionId, carId, trackId });
    expect(await db.select({ carId: sessions.carId, trackId: sessions.trackId, source: sessions.source, rawFile: sessions.rawFile, notes: sessions.notes })
      .from(sessions).where(eq(sessions.id, sessionId)).get()).toEqual({ carId, trackId, source: "motec", rawFile: sourcePath, notes: "session notes" });
    expect(await db.select({ id: laps.id, lapNumber: laps.lapNumber, lapTime: laps.lapTime, isValid: laps.isValid, notes: laps.notes })
      .from(laps).where(eq(laps.sessionId, sessionId)).get()).toEqual({ id: lap!.id, lapNumber: 7, lapTime: 91.25, isValid: true, notes: "lap note" });
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
  });

  test("rejects non-catalog identities and missing sessions", async () => {
    const inserted = await db.insert(sessions).values({ gameId: "fm-2023", carId: "old", trackId: "old" })
      .returning({ id: sessions.id }).get();
    const sessionId = inserted!.id;
    sessionIds.push(sessionId);
    const request = (id: number, carId: string, trackId: string) => sessionRoutes.request(`/api/sessions/${id}/identity`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "fm-2023", carId, trackId }),
    });

    const invalidResponse = await request(sessionId, "not-in-catalog", String(fmTrackCatalog.keys().next().value));
    expect(invalidResponse.status).toBe(400);
    expect((await invalidResponse.json()).error).toContain("catalog");
    const missingResponse = await request(2_000_000_000, String(fmCarCatalog.keys().next().value), String(fmTrackCatalog.keys().next().value));
    expect(missingResponse.status).toBe(404);
    expect((await missingResponse.json()).error).toBe("Session not found");
  });
});
