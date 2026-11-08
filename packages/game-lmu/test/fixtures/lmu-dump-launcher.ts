import { join } from "node:path";
import { runDumpProcesses } from "@raceiq/tooling/test-support/dump";

// Windows child.kill is forceful, not terminal Ctrl+C. Automated runs drive the
// launcher's signal event; a real terminal Ctrl+C smoke covers console delivery.
process.on("message", message => {
  if (message && typeof message === "object" && "type" in message && message.type === "shutdown") process.emit("SIGINT");
});
console.log("[E2E] Dump launcher ready");
process.exit(await runDumpProcesses(
  [process.execPath, "run", join(import.meta.dir, "lmu-dump-shutdown.ts"), "--dump-only"],
  process.argv.includes("--client-failure")
    ? [process.execPath, "--eval", "process.exit(7)"]
    // Keep a real sibling process alive until the launcher owns its termination.
    : [process.execPath, "--eval", "setInterval(() => {}, 60_000)"],
));
