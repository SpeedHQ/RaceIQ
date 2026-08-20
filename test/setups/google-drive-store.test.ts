import { expect, test } from "bun:test";
import { createSetupBackupStore } from "../../server/integrations/google-drive/setup-backup-store";

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
