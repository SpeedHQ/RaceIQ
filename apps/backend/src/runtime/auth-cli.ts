import { initDb, DB_PATH, client } from "@raceiq/backend-core/db/index";
import { DashboardAuth, PasswordSchema } from "./dashboard-auth";

export function readHiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Password recovery requires an interactive terminal (Docker: docker exec -it).");
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\n");
    }
    function onData(chunk: Buffer) {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Password recovery cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = [...value].slice(0, -1).join("");
        else if (character >= " " && value.length < 1024) value += character;
      }
    }
    process.stdin.on("data", onData);
  });
}

export async function resetDashboardPassword(args: string[]) {
  if (args.length !== 2 || args[0] !== "auth" || args[1] !== "reset") throw new Error("Usage: raceiq auth reset. Password arguments are not accepted.");
  if (process.env.SERVER_PASSWORD) throw new Error("Remove SERVER_PASSWORD from the server and recovery environment before resetting the UI-managed password.");
  await initDb();
  const auth = await DashboardAuth.create(client, DB_PATH, process.env, true);
  const password = await readHiddenPassword("New password: ");
  const confirmation = await readHiddenPassword("Confirm new password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");
  if (!PasswordSchema.safeParse(password).success) throw new Error("Password must contain 8 to 1024 characters. Numbers and special characters are optional.");
  await auth.reset(password);
  console.log("Dashboard password replaced. Previous sessions are invalid. A running server reads the replacement immediately; restart after removing environment overrides.");
}

export async function disableDashboardProtection(args: string[]) {
  if (args.length !== 3 || args[0] !== "auth" || args[1] !== "disable" || args[2] !== "--confirm-exposure") {
    throw new Error("Disabling protection lets anyone who can reach the dashboard read and edit its data and settings. To confirm, run: raceiq auth disable --confirm-exposure");
  }
  if (process.env.SERVER_PASSWORD) throw new Error("Remove SERVER_PASSWORD from the server and command environment before disabling dashboard protection.");
  await initDb();
  const auth = await DashboardAuth.create(client, DB_PATH, process.env, true);
  await auth.disable();
  console.log("Dashboard password protection disabled. Previous sessions are invalid. Anyone who can reach the dashboard can read and edit its data and settings. Network access is unchanged; restart after removing environment overrides.");
}
