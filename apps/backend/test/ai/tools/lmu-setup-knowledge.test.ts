import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { eq } from "drizzle-orm";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@raceiq/backend-core/db/index";
import { experiments } from "@raceiq/backend-core/db/schema";
import { createExperiment } from "@raceiq/backend-core/db/experiment-queries";
import { listExperimentVersions } from "@raceiq/backend-core/db/experiment-version-queries";
import { getLmuSetupKnowledgeTool } from "../../../src/mastra/tools/lmu-setup-knowledge";

const fixturePath = new URL("../../../../../packages/game-lmu-metadata/test/fixtures/SECTORFLOW_DRY_LMP3DKR_FUJ_0904_V2_Q.svm", import.meta.url);
let folder = "";
let previousSetupDir: string | undefined;
const experimentIds: number[] = [];

beforeEach(async () => {
  previousSetupDir = process.env.RACEIQ_LMU_SETUP_DIR;
  folder = await mkdtemp(join(tmpdir(), "raceiq-lmu-knowledge-"));
  process.env.RACEIQ_LMU_SETUP_DIR = folder;
  await mkdir(join(folder, "Fuji"));
  await copyFile(fixturePath, join(folder, "Fuji", "lmp3.svm"));
  await writeFile(join(folder, "Fuji", "lmdh.svm"), [
    'VehicleClassSetting="BMW M Hybrid V8 2023 Hypercar"',
    "//VEH=Installed\\Vehicles\\bmw_m_hybrid_v8_2023\\bmw_m_hybrid_v8_2023.veh",
    "[ENGINE]", "RegenerationMapSetting=1//test index", "ElectricMotorMapSetting=1//test index",
  ].join("\r\n"));
});

afterEach(async () => {
  for (const id of experimentIds.splice(0)) await db.delete(experiments).where(eq(experiments.id, id)).run();
  if (previousSetupDir === undefined) delete process.env.RACEIQ_LMU_SETUP_DIR;
  else process.env.RACEIQ_LMU_SETUP_DIR = previousSetupDir;
  await rm(folder, { recursive: true, force: true });
});

async function contextFor(setupPath: string | null): Promise<RequestContext> {
  const id = await createExperiment({ gameId: "lmu", name: "LMU knowledge regression", baseSetupPath: setupPath });
  experimentIds.push(id);
  const context = new RequestContext();
  context.set("gameId", "lmu");
  context.set("sessionId", id);
  return context;
}

async function lookup(topicId: string, requestContext = new RequestContext()) {
  const execute = getLmuSetupKnowledgeTool.execute;
  if (!execute) throw new Error("LMU knowledge tool has no execute function");
  const result = await execute({ topicId }, { requestContext } as never);
  if (typeof result !== "object" || result === null || !("available" in result) || !("applicability" in result)) {
    throw new Error("Unexpected LMU knowledge result");
  }
  return result;
}

describe("LMU knowledge applicability", () => {
  test("rejects unknown topics instead of presenting invented advice", async () => {
    const result = await lookup("invented-setup-control");
    expect(result.available).toBe(false);
  });

  test("does not present LMU knowledge as advice for another bound game", async () => {
    const context = new RequestContext();
    context.set("gameId", "acc");
    const result = await lookup("regen", context);
    expect(result.available).toBe(false);
  });

  test("does not infer car applicability without a setup", async () => {
    const result = await lookup("regen");
    expect(result.available).toBe(true);
    expect(result.applicability).toBe("unknown");
  });

  test("keeps general knowledge usable when an experiment has no setup or a missing source", async () => {
    for (const setupPath of [null, "Fuji/missing.svm"]) {
      const result = await lookup("regen", await contextFor(setupPath));
      expect(result.available).toBe(true);
      expect(result.applicability).toBe("unknown");
    }
  });

  test("blocks hybrid-only applicability on real LMP3 without blocking Virtual Energy", async () => {
    const context = await contextFor("Fuji/lmp3.svm");
    const sourcePath = join(folder, "Fuji", "lmp3.svm");
    const original = await readFile(sourcePath);
    const id = context.get("sessionId") as number;
    const history = await listExperimentVersions(id);
    const regen = await lookup("regen", context);
    const energy = await lookup("virtualEnergy", context);
    expect(regen.applicability).toBe("unavailable");
    expect(energy.applicability).toBe("available");
    expect(await readFile(sourcePath)).toEqual(original);
    expect(await listExperimentVersions(id)).toEqual(history);
  });

  test("keeps concurrent experiment capabilities separate", async () => {
    const lmp3 = await contextFor("Fuji/lmp3.svm");
    const lmdh = await contextFor("Fuji/lmdh.svm");
    const [nonHybrid, hybrid] = await Promise.all([lookup("regen", lmp3), lookup("regen", lmdh)]);
    expect(nonHybrid.applicability).toBe("unavailable");
    expect(hybrid.applicability).toBe("available");
  });
});
