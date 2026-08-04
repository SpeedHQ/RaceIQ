import { writeFile } from "node:fs/promises";
import {
  OUTPUT_PATH,
} from "./model";
import type { BuiltTelemetryCatalog } from "./model";
import { buildTelemetryCatalog } from "./builder";
import {
  buildTelemetryCatalogArtifacts,
  assertDirectToSimplifiedCompatibilityReviews,
  readBaselineCatalog,
  verifyArtifacts,
} from "./rendering";
import { telemetryCatalogSourceHash } from "./contract-enrichment";
import { baselineArgument } from "./cli";

export {
  buildTelemetryCatalog,
  buildTelemetryCatalogArtifacts,
  telemetryCatalogSourceHash,
  assertDirectToSimplifiedCompatibilityReviews,
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const repeat = args.includes("--repeat");
  const baselinePath = baselineArgument(args);
  if (baselinePath && !check) {
    throw new Error("--baseline is only valid with --check");
  }
  const artifacts = await buildTelemetryCatalogArtifacts();
  const catalogJson = artifacts.get(OUTPUT_PATH);
  if (!catalogJson) throw new Error("Generated telemetry catalog JSON is missing");
  const catalog = JSON.parse(catalogJson) as BuiltTelemetryCatalog;
  if (repeat) {
    const repeated = await buildTelemetryCatalogArtifacts();
    for (const [path, content] of artifacts) {
      if (repeated.get(path) !== content) {
        throw new Error(`Non-deterministic telemetry catalog artifact ${path}`);
      }
    }
  }
  if (check) {
    if (baselinePath) {
      assertDirectToSimplifiedCompatibilityReviews(
        catalog,
        await readBaselineCatalog(baselinePath),
      );
    }
    await verifyArtifacts(artifacts);
  } else {
    await Promise.all(
      [...artifacts].map(([path, content]) => writeFile(path, content, "utf8")),
    );
  }
  console.log(
    `${check ? "Verified" : "Wrote"} ${catalog.variables.length} semantic variables and ${Object.values(catalog.sources).reduce((sum, list) => sum + list.length, 0)} parser/source links`,
  );
}
