import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "@raceiq/backend-core/db/index";
import { installShutdown } from "../../../../src/runtime/shutdown";
import { CodexProviderAdapter } from "../../../../src/ai/provider-adapters";

const directory = process.argv[2];
await initDb();
installShutdown({ getNativeSources: () => null, getStartupWorker: () => null, clearDashboardPublicationNotifications() {} });
const adapter = new CodexProviderAdapter({
  feature: "analysis",
  model: "gpt-6.1-sol",
  command: [process.execPath, fileURLToPath(new URL("./codex-runtime-peer.ts", import.meta.url)), "stubborn-turn", join(directory, "owned-pid")],
});
await adapter.generateText({ prompt: "fixture" }).catch(() => {});
