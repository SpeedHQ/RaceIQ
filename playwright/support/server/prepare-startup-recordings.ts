import { request } from "@playwright/test";
import { runtime } from "../../config/runtime";

// Seeded UI projects start with existing recordings. Complete the real consent
// flow before testing unrelated pages, rather than hiding its blocking dialog.
export default async function prepareStartupRecordings(): Promise<void> {
  if (runtime.screenshotOnly) return;
  const servers = [
    ...(runtime.needsTunesServer ? [runtime.tunes] : []),
    ...(runtime.needsSeededServer ? [runtime.seeded] : []),
  ];
  for (const server of servers) {
    const api = await request.newContext({
      baseURL: `http://localhost:${runtime.devServer ? server.clientPort : server.port}`,
      timeout: 30_000,
    });
    try {
      const deadline = Date.now() + 240_000;
      while (true) {
        const response = await api.get("/api/storage/split-migration");
        if (!response.ok()) throw new Error(`Split fixture status failed: ${response.status()}`);
        const status = await response.json() as { sessionCount: number; progress: { status: string; error: string | null } };
        if (status.progress.status === "success" || status.sessionCount === 0 && status.progress.status === "idle") break;
        if (["error", "partial"].includes(status.progress.status)) {
          throw new Error(`Seeded recording split failed: ${status.progress.error}`);
        }
        if (Date.now() >= deadline) throw new Error("Seeded recording split did not finish before browser tests");
        if (status.progress.status === "idle") {
          const started = await api.post("/api/storage/split-migration", { data: {} });
          if (!started.ok()) throw new Error(`Split fixture consent failed: ${started.status()}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      await api.dispose();
    }
  }
}
