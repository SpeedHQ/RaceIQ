import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitParaglideDeclarations } from "../../dev/paraglide-declarations";

const clientRoot = resolve(import.meta.dir, "../../../client");

test("native declarations retain message inputs and locale restrictions", async () => {
  const outdir = await mkdtemp(join(tmpdir(), "paraglide-declarations-"));
  try {
    await writeFile(join(outdir, "messages.js"), `
/** @param {{ name: string }} inputs @param {{ locale?: "en" | "de" }} [options] */
export function greeting(inputs, options) { return inputs.name; }
`);
    await emitParaglideDeclarations(clientRoot, outdir);
    await writeFile(join(outdir, "consumer.ts"), `
import { greeting } from "./messages.js";
const message: string = greeting({ name: "Driver" }, { locale: "de" });
// @ts-expect-error Message inputs must be supplied.
greeting();
// @ts-expect-error Message input types must be preserved.
greeting({ name: 42 });
// @ts-expect-error Unsupported locales must be rejected.
greeting({ name: "Driver" }, { locale: "unsupported" });
`);
    const check = Bun.spawn(["bun", "check", "--strict", "--noEmit", join(outdir, "consumer.ts")], {
      cwd: clientRoot, stdout: "inherit", stderr: "inherit",
    });
    expect(await check.exited).toBe(0);
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
}, 30_000);
