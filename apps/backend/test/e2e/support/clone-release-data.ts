import { cp } from "node:fs/promises";
import { join, sep } from "node:path";
import Database from "libsql";

/** Copy historical data without allowing maintenance in one test to mutate another fixture. */
export async function cloneReleaseData(source: string, destination: string) {
  await cp(source, destination, { recursive: true });
  const database = new Database(join(destination, "app.db"));
  try {
    database.prepare(`UPDATE sessions SET raw_file=? || substr(raw_file,?)
      WHERE substr(raw_file,1,?)=?`).run(destination, source.length + 1, source.length + 1, `${source}${sep}`);
  } finally {
    database.close();
  }
  const settingsPath = join(destination, "settings.json");
  if (await Bun.file(settingsPath).exists()) {
    const settings = await Bun.file(settingsPath).json();
    if (typeof settings.recordingDirectory === "string" && settings.recordingDirectory.startsWith(`${source}${sep}`)) {
      settings.recordingDirectory = destination + settings.recordingDirectory.slice(source.length);
      await Bun.write(settingsPath, JSON.stringify(settings));
    }
  }
}
