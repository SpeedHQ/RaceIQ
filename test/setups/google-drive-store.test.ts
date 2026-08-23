import { expect, test } from "bun:test";
import { createSetupBackupStore } from "../../server/integrations/google-drive/setup-backup-store";
import { buildSetupBackupArchive } from "../../server/setups/backup-archive";

test("rejects arbitrary Drive IDs that are not app-owned", async () => {
  const fakeApi = { files: { get: async () => ({ data: { id: "x", appProperties: { raceiq: "other" }, parents: [] } }), list: async () => ({ data: { files: [] } }) } } as never;
  const store = createSetupBackupStore({ authClient: {} as never, driveFactory: () => fakeApi });
  await expect(store.download("acc", "x")).rejects.toMatchObject({ code: "backup-not-found" });
});

test("maps Drive 503 errors to drive-unavailable", async () => {
  const fakeApi = { files: { list: async () => { throw Object.assign(new Error("offline"), { response: { status: 503 } }); } } } as never;
  const store = createSetupBackupStore({ authClient: {} as never, driveFactory: () => fakeApi });
  await expect(store.list("acc")).rejects.toMatchObject({ code: "drive-unavailable" });
});

test("lists a backup without repeating hierarchy containment checks", async () => {
  const archive = buildSetupBackupArchive({
    manifest: {
      schemaVersion: 1,
      gameId: "acc",
      carId: "car",
      trackId: "track",
      setupName: "Race",
      nativeFormat: "acc-json",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    payload: Buffer.from('{"carName":"car","basicSetup":{}}'),
  });
  const children: Record<string, unknown[]> = {
    root: [{ id: "raceiq", name: "RaceIQ", mimeType: "application/vnd.google-apps.folder" }],
    raceiq: [{ id: "setups", name: "Setups", mimeType: "application/vnd.google-apps.folder" }],
    setups: [{ id: "acc", name: "acc", mimeType: "application/vnd.google-apps.folder" }],
    acc: [{ id: "backup", name: "Race.raceiq-setup.zip", mimeType: "application/zip", appProperties: { raceiq: "setup-backup", raceiqKind: "setup-archive" } }],
  };
  let listCalls = 0;
  let getCalls = 0;
  const fakeApi = {
    files: {
      list: async ({ q }: { q: string }) => {
        listCalls++;
        const parent = q.match(/^'([^']+)'/)?.[1] ?? "";
        return { data: { files: children[parent] ?? [] } };
      },
      get: async ({ alt }: { alt?: string }) => {
        getCalls++;
        if (alt === "media") return { data: archive };
        return { data: { id: "backup", name: "Race.raceiq-setup.zip", mimeType: "application/zip", appProperties: { raceiq: "setup-backup", raceiqKind: "setup-archive" } } };
      },
    },
  } as never;
  const store = createSetupBackupStore({ authClient: {} as never, driveFactory: () => fakeApi });

  expect(await store.list("acc")).toHaveLength(1);
  expect(listCalls).toBe(4);
  expect(getCalls).toBe(1);
});
