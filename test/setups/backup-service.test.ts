import { expect, test } from "bun:test";
import { createBackupService } from "../../server/setups/backup-service";
import type { SetupBackupStore } from "../../server/integrations/google-drive/setup-backup-store";

const unusedStore = {
  list: async () => [],
  upload: async () => ({ id: "unused" }),
  download: async () => Buffer.alloc(0),
  update: async () => {},
  delete: async () => {},
} satisfies SetupBackupStore;

test("reports a missing setup folder instead of a missing local file", async () => {
  const service = createBackupService({
    store: unusedStore,
    local: {
      read: async () => { throw new Error("Setups folder not found"); },
      write: async () => { throw new Error("unused"); },
    },
  });

  await expect(service.backupLocalSetup({
    gameId: "acc",
    localPath: "C:\\missing\\Race.json",
    conflict: "error",
  })).rejects.toMatchObject({ code: "setup-folder-missing" });
});
