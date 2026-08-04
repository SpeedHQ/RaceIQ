import { resolve } from "path";
import { fillMissingPerformance } from "./performance";
import { matchCatalog, readCatalog } from "./catalog";
import { downloadImages, resolveImageUrls, writeCsv } from "./output";
import { fetchCarPages, fetchWikiCars } from "./wiki";

export async function main(): Promise<void> {
  const projectRoot = resolve(import.meta.dir, "../../../");
  console.log("Step 1: Fetching car list...");
  const pageNames = await fetchCarPages();
  console.log(`  Found ${pageNames.length} car pages`);
  console.log("Step 2: Fetching individual car pages...");
  const wikiCars = await fetchWikiCars(pageNames);
  console.log(`\nStep 2 complete: ${wikiCars.length} / ${pageNames.length} cars parsed`);
  await fillMissingPerformance(wikiCars);
  console.log("\nStep 4: Resolving image URLs...");
  const imageUrls = await resolveImageUrls(wikiCars);
  console.log("\nStep 5: Matching to cars.csv...");
  const ourCars = readCatalog(resolve(projectRoot, "shared/games/fm-2023/cars.csv"));
  const { rows, unmatched } = matchCatalog(ourCars, wikiCars, imageUrls);
  console.log(`  Matched: ${rows.length} / ${ourCars.length} (unmatched: ${unmatched.length})`);
  for (const value of unmatched) console.log(`    ${value}`);
  console.log("\nStep 6: Downloading car images...");
  await downloadImages(rows, projectRoot);
  writeCsv(rows, resolve(projectRoot, "shared/games/fm-2023/car-specs.csv"));
  console.log(`\nWritten: shared/games/fm-2023/car-specs.csv (${rows.length} rows)`);
}
