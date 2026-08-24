import { buildTrackRegistryArtifacts } from "../../shared/racing/tracks/registry/projection";
import { loadTrackRegistrySource } from "../../shared/racing/tracks/registry/source";
import { assertTrackRegistryArtifactsCurrent, recoverTrackRegistrySourceUpdate, updateTrackRegistrySource } from "../../shared/racing/tracks/registry/update";

function main(args: string[]): void {
  const check = args.includes("--check");
  const unknown = args.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }

  if (check) {
    assertTrackRegistryArtifactsCurrent();
    console.log("Track registry artifacts are current.");
    return;
  }

  recoverTrackRegistrySourceUpdate();
  updateTrackRegistrySource(() => undefined);
  try {
    assertTrackRegistryArtifactsCurrent();
    console.log("Track registry artifacts already current.");
    return;
  } catch {
    // Source is valid but generated projection or report is stale.
  }

  const source = loadTrackRegistrySource();
  const { sourceHash, projection } = buildTrackRegistryArtifacts(source);
  console.log(`Built track registry ${sourceHash.slice(0, 12)}: ${projection.venueNodes.length} venues, ${projection.layouts.length} layouts, ${projection.assignments.length} assignments.`);
}

main(process.argv.slice(2));
