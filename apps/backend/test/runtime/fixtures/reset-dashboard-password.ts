import { PassThrough } from "node:stream";
import { client } from "@raceiq/backend-core/db/index";
import { resetDashboardPassword } from "../../../src/runtime/auth-cli";

// Simulate terminal input only; execute the real recovery command and database
// initialization in a separate process, without requiring a platform-specific PTY.
const password = process.env.RACEIQ_AUTH_RECOVERY_PASSWORD;
if (!password) throw new Error("Recovery fixture requires a password");
const input = Object.assign(new PassThrough(), {
  isTTY: true,
  isRaw: false,
  setRawMode(raw: boolean) {
    this.isRaw = raw;
    return this;
  },
});
input.on("newListener", (event) => {
  if (event === "data") queueMicrotask(() => input.write(`${password}\r`));
});
Object.defineProperty(process, "stdin", { value: input });
try {
  await resetDashboardPassword(["auth", "reset"]);
} finally {
  client.close();
  input.destroy();
}
