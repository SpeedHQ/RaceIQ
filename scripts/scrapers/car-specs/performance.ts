import { API, type WikiCar } from "./types";

export function parseHtmlStats(html: string, car: WikiCar): void {
  const num = (pattern: RegExp): number | undefined => { const match = html.match(pattern); return match ? parseFloat(match[1]) : undefined; };
  car.topSpeedMph = num(/Top Speed:\s*([\d.]+)\s*mph/) ?? car.topSpeedMph; car.quarterMile = num(/1\/4 Mile:\s*([\d.]+)\s*secs/) ?? car.quarterMile; car.zeroToSixty = num(/0-60 mph[^:]*:\s*([\d.]+)\s*secs/) ?? car.zeroToSixty; car.zeroToHundred = num(/0-100 mph[^:]*:\s*([\d.]+)\s*secs/) ?? car.zeroToHundred; car.braking60 = num(/60-0 mph[^:]*:\s*([\d.]+)\s*ft/) ?? car.braking60; car.braking100 = num(/100-0 mph[^:]*:\s*([\d.]+)\s*ft/) ?? car.braking100; car.lateralG60 = num(/60 mph[^:]*:\s*([\d.]+)\s*g/) ?? car.lateralG60; car.lateralG120 = num(/120 mph[^:]*:\s*([\d.]+)\s*g/) ?? car.lateralG120;
}

export async function fillMissingPerformance(cars: WikiCar[]): Promise<void> {
  const missing = cars.filter(car => car.pi && car.pi > 0 && !car.topSpeedMph && !car.zeroToSixty);
  console.log(`\nStep 3: Fetching HTML stats for ${missing.length} cars missing performance data...`);
  let fetched = 0;
  for (let i = 0; i < missing.length; i += 10) {
    await Promise.all(missing.slice(i, i + 10).map(async car => {
      const url = `${API}?action=parse&page=${encodeURIComponent(car.pageName)}&prop=text&format=json`;
      try {
        const response = await fetch(url);
        const payload = await response.json() as Record<string, unknown>;
        const parse = payload.parse && typeof payload.parse === "object" ? payload.parse as Record<string, unknown> : {};
        const text = parse.text && typeof parse.text === "object" ? parse.text as Record<string, unknown> : {};
        const html = String(text["*"] ?? "");
        const table = html.match(/<table[^>]*class="[^"]*fm23[^"]*"[^>]*>([\s\S]*?)<\/table>/);
        if (table) { parseHtmlStats(table[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " "), car); fetched++; }
      } catch { /* preserve fallback skip */ }
    }));
    process.stdout.write(`\r  ${Math.min(i + 10, missing.length)}/${missing.length}`);
  }
  console.log(`\n  Filled stats for ${fetched} / ${missing.length} cars`);
}
