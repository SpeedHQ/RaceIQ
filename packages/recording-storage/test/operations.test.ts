import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cleanupOwnedRecordingTemporary, cleanupVerifiedRecordingSource, cleanupVerifiedRecordingSources, verifyRecordingDestinations, persistRecordingJournal, publishRecordingFile, validateLayoutMigrationJournal, validateRelocationJournal } from "../src/operations";

const temporaryRoots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "recording-storage-"));
  temporaryRoots.push(root);
  return root;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("recording storage filesystem operations", () => {
  test("publishes verified bytes atomically and leaves no temporary files", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.bin");
    const target = join(root, "nested", "published.bin");
    const bytes = Buffer.from("validated recording payload");
    await writeFile(source, bytes, { mode: 0o640 });

    await publishRecordingFile(source, target, digest(bytes), async (path) => digest(await readFile(path)));

    expect(await readFile(target)).toEqual(bytes);
    expect((await readdir(join(root, "nested"))).sort()).toEqual(["published.bin"]);
  });

  test("preserves an existing target and cleans temporary publication after collision", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.bin");
    const target = join(root, "published.bin");
    const bytes = Buffer.from("source bytes");
    await writeFile(source, bytes);
    await writeFile(target, "existing bytes");

    await expect(publishRecordingFile(source, target, digest(bytes), async (path) => digest(await readFile(path)))).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(target, "utf8")).toBe("existing bytes");
    expect((await readdir(root)).sort()).toEqual(["published.bin", "source.bin"]);
  });

  test("persists journal durably in readable form and atomically replaces prior journal", async () => {
    const root = await temporaryRoot();
    const path = join(root, "journal.json");
    const first = { version: 1, phase: "copying", entries: ["old"] };
    const recovered = { version: 1, phase: "committing", entries: ["new"] };
    await persistRecordingJournal(path, first);
    await persistRecordingJournal(path, recovered);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(recovered);
    expect(await readdir(root)).toEqual(["journal.json"]);
  });
  test("rejects relocation journals with path escape", async () => {
    const root = await temporaryRoot();
    const outside = join(root, "outside");
    const oldDirectory = join(root, "old");
    const newDirectory = join(root, "new");
    await mkdir(oldDirectory, { recursive: true });
    await mkdir(newDirectory, { recursive: true });
    const value = {
      version: 1, operationId: "123e4567-e89b-42d3-a456-426614174000",
      oldDirectory, newDirectory, oldSetting: null,
      entries: [{
        source: join(root, "escape.bin"), destination: join(newDirectory, "escape.bin"),
        size: 0, sha256: digest(Buffer.alloc(0)), published: false,
      }],
      references: [],
    };
    expect(await validateRelocationJournal(value, { dataDirectory: outside })).toBe(false);
  });

  test("validates layout journals while delegating DB reference semantics", async () => {
    const root = await temporaryRoot();
    const source = join(root, "fm-2023", "session.bin");
    await mkdir(join(root, "fm-2023"), { recursive: true });
    await writeFile(source, "recording");
    const journal = {
      version: 1 as const, root, destination: root, phase: "organizing" as const,
      entries: [{ source, digest: digest(Buffer.from("recording")), destinations: [join(root, "fm-2023", "own", "session.bin")], published: [], references: [], cutover: false }],
      progress: { status: "running" as const, done: 0, total: 1, migrated: 0, failed: 0, error: null },
    };
    const context = { currentDirectory: root, knownGames: new Set(["fm-2023"]), isReferenced: async () => false };
    expect(await validateLayoutMigrationJournal(journal, context)).toBe(true);
    expect(await validateLayoutMigrationJournal({ ...journal, entries: [{ ...journal.entries[0], destinations: [join(root, "..", "escape.bin")] }] }, context)).toBe(false);
  });
  test("cleans only hash-verified sources and removes journal after cleanup", async () => {
    const root = await temporaryRoot();
    const source = join(root, "nested", "source.bin");
    const journal = join(root, "journal.json");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(source, "verified");
    await writeFile(journal, "{}");
    const hash = async (path: string) => ({ size: (await readFile(path)).length, sha256: digest(await readFile(path)) });
    await cleanupVerifiedRecordingSources({ oldDirectory: root, entries: [{ source, destination: "", size: 8, sha256: digest(Buffer.from("verified")) }] }, journal, hash);
    expect(await readFile(source).catch(() => null)).toBeNull();
    expect(await readFile(journal).catch(() => null)).toBeNull();
  });

  test("retains changed sources when cleanup hashing fails", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.bin");
    const journal = join(root, "journal.json");
    await writeFile(source, "changed");
    await writeFile(journal, "{}");
    await expect(cleanupVerifiedRecordingSources({ oldDirectory: root, entries: [{ source, destination: "", size: 8, sha256: "wrong" }] }, journal, async () => { throw new Error("hash failure"); })).rejects.toMatchObject({ code: "SOURCE_CLEANUP_FAILED" });
    expect(await readFile(source, "utf8")).toBe("changed");
    expect(await readFile(journal, "utf8")).toBe("{}");
  });
  test("removes hash-verified migration source and its empty directory", async () => {
    const root = await temporaryRoot();
    const sourceDirectory = join(root, "legacy");
    const source = join(sourceDirectory, "source.bin");
    const bytes = Buffer.from("verified migration source");
    await mkdir(sourceDirectory);
    await writeFile(source, bytes);
    await cleanupVerifiedRecordingSource(root, source, digest(bytes), async (path) => digest(await readFile(path)));
    expect(await readFile(source).catch(() => null)).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  test("retains changed migration source", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.bin");
    await writeFile(source, "changed");
    await expect(cleanupVerifiedRecordingSource(root, source, "wrong", async (path) => digest(await readFile(path)))).rejects.toMatchObject({ code: "SOURCE_CLEANUP_FAILED" });
    expect(await readFile(source, "utf8")).toBe("changed");
  });

  test("verifies destinations using real files", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "destination.bin");
    await writeFile(destination, "verified");
    const hash = async (path: string) => ({ size: (await readFile(path)).length, sha256: digest(await readFile(path)) });
    await verifyRecordingDestinations([{ source: "", destination, size: 8, sha256: digest(Buffer.from("verified")) }], hash);
  });
});
