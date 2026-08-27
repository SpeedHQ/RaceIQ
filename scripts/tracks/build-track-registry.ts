import { assertBundledIRacingSvgTrackMaps } from "../../server/games/iracing/track-map";
import { buildTrackRegistryArtifacts } from "../../shared/racing/tracks/registry/read-model";
import { loadTrackRegistrySource } from "../../shared/racing/tracks/registry/source";
import { assertTrackRegistryArtifactsCurrent, recoverTrackRegistrySourceUpdate, updateTrackRegistrySource } from "../../shared/racing/tracks/registry/update";

async function main(args: string[]): Promise<void> {
  const check = args.includes("--check");
  const unknown = args.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }

  if (check) {
    assertTrackRegistryArtifactsCurrent();
    const mapCount = await assertBundledIRacingSvgTrackMaps();
    console.log(`Track registry artifacts are current; validated ${mapCount} bundled iRacing SVG maps.`);
    return;
  }

  recoverTrackRegistrySourceUpdate();
  updateTrackRegistrySource(() => undefined);
  let artifactsCurrent = true;
  try {
    assertTrackRegistryArtifactsCurrent();
  } catch {
    artifactsCurrent = false;
  }
  if (artifactsCurrent) {
    const mapCount = await assertBundledIRacingSvgTrackMaps();
    console.log(`Track registry artifacts already current; validated ${mapCount} bundled iRacing SVG maps.`);
    return;
  }

  const source = loadTrackRegistrySource();
  const { sourceHash, registry } = buildTrackRegistryArtifacts(source);
  const mapCount = await assertBundledIRacingSvgTrackMaps();
  console.log(
    `Built track registry ${sourceHash.slice(0, 12)}: ${registry.venues.length} venues, ${registry.layouts.length} layouts, ${registry.assignments.length} assignments, ${mapCount} bundled iRacing SVG maps.`,
  );
}

await main(process.argv.slice(2));
