import { expect, test } from "bun:test";
import type { GameId } from "@raceiq/shared/games/ids";
import { deleteSession, insertSession, updateSessionRawFile, updateSessionSource } from "../../../db/session-queries";
import { insertLap } from "../../../db/lap-mutation-queries";
import { getOnlineUploadCandidatePage, type OnlineUploadCandidate } from "../../../db/online-upload-queries";

async function addLap(input: {
  gameId?: string;
  trackId: string;
  carId: string;
  lapTime: number;
  ownership?: "mine" | "others";
  source?: string;
  sectors?: number[] | null;
  valid?: boolean;
}) {
  const sessionId = await insertSession(input.carId, input.trackId, (input.gameId ?? "acc") as GameId, undefined, undefined, input.ownership);
  await updateSessionRawFile(sessionId, "/fixture/local-session.bin", "fixture-detector");
  if (input.source) await updateSessionSource(sessionId, input.source);
  const sectors = input.sectors === undefined ? [input.lapTime / 3, input.lapTime / 3, input.lapTime / 3] : input.sectors;
  const lapId = await insertLap(sessionId, 1, input.lapTime, input.valid ?? true, 0, 10, null, null, null, sectors);
  return { sessionId, lapId };
}

test("online candidate pages choose best local raw lap per game/track, not car", async () => {
  const created: number[] = [];
  try {
    const slower = await addLap({ trackId: "upload-fixture-track", carId: "car-slower", lapTime: 100 });
    created.push(slower.sessionId);
    const fastestOtherCar = await addLap({ trackId: "upload-fixture-track", carId: "car-fastest", lapTime: 90 });
    created.push(fastestOtherCar.sessionId);
    const otherGame = await addLap({ gameId: "iracing", trackId: "upload-fixture-track", carId: "car-iracing", lapTime: 80 });
    created.push(otherGame.sessionId);
    const thirdParty = await addLap({ trackId: "upload-fixture-third-party", carId: "car-third-party", lapTime: 70, ownership: "others" });
    created.push(thirdParty.sessionId);
    const motec = await addLap({ trackId: "upload-fixture-motec", carId: "car-motec", lapTime: 60, source: "motec" });
    created.push(motec.sessionId);
    const cloudImport = await addLap({ trackId: "upload-fixture-cloud", carId: "car-cloud", lapTime: 55, source: "cloud-import" });
    created.push(cloudImport.sessionId);
    const missingSectors = await addLap({ trackId: "upload-fixture-no-sectors", carId: "car-no-sectors", lapTime: 54, sectors: null });
    created.push(missingSectors.sessionId);
    const invalidSector = await addLap({ trackId: "upload-fixture-invalid-sector", carId: "car-invalid-sector", lapTime: 53, sectors: [20, 0, 30] });
    created.push(invalidSector.sessionId);
    const invalidLap = await addLap({ trackId: "upload-fixture-invalid-lap", carId: "car-invalid-lap", lapTime: 52, valid: false });
    created.push(invalidLap.sessionId);
    const unsupportedGame = await addLap({ gameId: "unsupported-game", trackId: "upload-fixture-unsupported", carId: "car-unsupported", lapTime: 51 });
    created.push(unsupportedGame.sessionId);
    const f1World = await addLap({ gameId: "f1-2025", trackId: "upload-fixture-f1", carId: "41", lapTime: 90 });
    created.push(f1World.sessionId);
    const f1OtherCar = await addLap({ gameId: "f1-2025", trackId: "upload-fixture-f1-other", carId: "44", lapTime: 70 });
    created.push(f1OtherCar.sessionId);

    const rows: OnlineUploadCandidate[] = [];
    let afterGameId = "";
    let afterTrackId = "";
    for (;;) {
      const page = await getOnlineUploadCandidatePage(afterGameId, afterTrackId);
      if (page.length === 0) break;
      rows.push(...page);
      afterGameId = page[page.length - 1]!.gameId;
      afterTrackId = page[page.length - 1]!.trackId;
    }
    expect(rows).toContainEqual(expect.objectContaining({ lapId: fastestOtherCar.lapId, gameId: "acc", trackId: "upload-fixture-track", carId: "car-fastest", valid: true }));
    expect(rows).toContainEqual(expect.objectContaining({ lapId: otherGame.lapId, gameId: "iracing", trackId: "upload-fixture-track" }));
    expect(rows.some((row) => row.lapId === f1World.lapId)).toBe(true);
    expect(rows.some((row) => row.lapId === f1OtherCar.lapId)).toBe(false);
    expect(rows.some((row) => row.lapId === slower.lapId)).toBe(false);
    expect(rows.some((row) => row.lapId === thirdParty.lapId || row.lapId === motec.lapId)).toBe(false);
    expect(rows.some((row) => [cloudImport, missingSectors, invalidSector, invalidLap, unsupportedGame].some(({ lapId }) => row.lapId === lapId))).toBe(false);
    expect(await getOnlineUploadCandidatePage("acc", "upload-fixture-track")).toContainEqual(expect.objectContaining({ lapId: otherGame.lapId }));
  } finally {
    for (const sessionId of created) await deleteSession(sessionId);
  }
});
