import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { API, BATCH, CarSpecRow, WikiCar } from "./types";
import { fetchJson } from "./wiki";

export async function resolveImageUrls(cars: WikiCar[]): Promise<Map<string, string>> {
  const files = [...new Set(cars.map(car => car.imageFile).filter((value): value is string => !!value))];
  const urls = new Map<string, string>();
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const titles = batch.map(file => encodeURIComponent(`File:${file}`)).join("|");
    const data = await fetchJson(`${API}?action=query&titles=${titles}&prop=imageinfo&iiprop=url&format=json`);
    const pages = data.query && typeof data.query === "object" ? jsonPages(data.query) : [];
    for (const page of pages) {
      if (!isRecord(page)) continue;
      const imageInfo = Array.isArray(page.imageinfo) && isRecord(page.imageinfo[0]) ? page.imageinfo[0] : undefined;
      const imageUrl = imageInfo?.url;
      const title = typeof page.title === "string" ? page.title.replace(/^File:/, "") : "";
      if (typeof imageUrl === "string" && title) urls.set(title, imageUrl);
    }
    console.log(` ${batch.length} image files resolved`);
    if (i + BATCH < files.length) await Bun.sleep(300);
  }
  return urls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function jsonPages(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.pages)) return value.pages;
  return isRecord(value.pages) ? Object.values(value.pages) : [];
}

export async function downloadImages(rows: CarSpecRow[], projectRoot: string): Promise<void> {
  const imgDir = resolve(projectRoot, "client/public/car-images");
  mkdirSync(imgDir, { recursive: true });
  let downloaded = 0, skipped = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 10) {
    await Promise.all(rows.slice(i, i + 10).map(async row => {
      if (!row.cdnImageUrl) { row.imageUrl = ""; return; }
      const extension = row.cdnImageUrl.match(/\.(png|jpg|jpeg|webp)/i)?.[1] ?? "png";
      const localFile = resolve(imgDir, `${row.ordinal}.${extension}`);
      row.imageUrl = `/car-images/${row.ordinal}.${extension}`;
      if (existsSync(localFile)) { skipped++; return; }
      try {
        const response = await fetch(row.cdnImageUrl);
        if (!response.ok) { failed++; row.imageUrl = ""; return; }
        writeFileSync(localFile, Buffer.from(await response.arrayBuffer())); downloaded++;
      } catch { failed++; row.imageUrl = ""; }
    }));
    process.stdout.write(`\r  ${Math.min(i + 10, rows.length)}/${rows.length} (${downloaded} new, ${skipped} cached, ${failed} failed)`);
  }
  console.log("\n  Done.");
}

export function writeCsv(rows: CarSpecRow[], outputPath: string): void {
  const header = "ordinal,hp,torque,weightLbs,weightKg,displacement,engine,drivetrain,gears,aspiration,frontWeightPct,pi,speedRating,brakingRating,handlingRating,accelRating,price,division,topSpeedMph,quarterMile,zeroToSixty,zeroToHundred,braking60,braking100,lateralG60,lateralG120,imageUrl,wikiUrl,synopsis";
  const lines = rows.map(row => [row.ordinal, row.hp, row.torque, row.weightLbs, row.weightKg, row.displacement, `"${row.engine}"`, row.drivetrain, row.gears, row.aspiration, row.frontWeightPct, row.pi, row.speedRating, row.brakingRating, row.handlingRating, row.accelRating, row.price, `"${row.division}"`, row.topSpeedMph, row.quarterMile, row.zeroToSixty, row.zeroToHundred, row.braking60, row.braking100, row.lateralG60, row.lateralG120, `"${row.imageUrl}"`, `"${row.wikiUrl}"`, `"${row.synopsis}"`].join(","));
  writeFileSync(outputPath, [header, ...lines].join("\n") + "\n");
}
