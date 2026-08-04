import { API, BATCH, WikiCar } from "./types";

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function layoutToDrivetrain(layout: string): string {
  if (["ff", "mf"].includes(layout.toLowerCase())) return "FWD";
  if (["ma", "fa", "4wd", "aa", "aw"].includes(layout.toLowerCase())) return "AWD";
  return "RWD";
}

export function parsePage(content: string, pageName: string): WikiCar | null {
  const car: WikiCar = { pageName };
  const infoboxMatch = content.match(/\{\{CarInfobox([\s\S]*?)\n\}\}/);
  if (infoboxMatch) {
    const body = infoboxMatch[1];
    const field = (key: string): string | undefined => body.match(new RegExp(`\\|\\s*${key}\\s*=\\s*([^\\n|{\\[]+)`))?.[1].trim() || undefined;
    car.year = field("year") ? parseInt(field("year")!, 10) : undefined;
    car.wikiMake = field("manufacturer"); car.wikiModel = field("model"); car.hp = field("power") ? parseInt(field("power")!, 10) : undefined; car.torque = field("torque") ? parseInt(field("torque")!, 10) : undefined; car.weightLbs = field("weight") ? parseInt(field("weight")!, 10) : undefined; car.displacement = field("disp") ? parseFloat(field("disp")!) : undefined; car.engine = field("engine"); car.drivetrain = layoutToDrivetrain(field("layout") ?? "fr"); car.gears = field("gears") ? parseInt(field("gears")!, 10) : undefined; car.aspiration = field("aspiration"); car.frontWeightPct = field("front") ? parseInt(field("front")!, 10) : undefined; car.imageFile = field("image");
  }
  const statsMatch = content.match(/\{\{CarStats\|fm23([\s\S]*?)\}\}/);
  if (statsMatch) {
    const body = statsMatch[1];
    const positional = body.split("\n").join("|").split("|").map(value => value.trim()).filter(value => value && !value.includes("=") && /^[\d.]+$/.test(value));
    if (positional.length >= 5) { car.speedRating = parseFloat(positional[0]); car.brakingRating = parseFloat(positional[1]); car.handlingRating = parseFloat(positional[2]); car.accelRating = parseFloat(positional[3]); car.pi = parseInt(positional[4], 10); }
    const named = (key: string): string | undefined => body.match(new RegExp(`\\|\\s*${key}\\s*=\\s*([^\\n|]+)`))?.[1].trim().replace(/,/g, "") || undefined;
    car.price = named("price") ? parseInt(named("price")!, 10) : undefined; car.division = named("div"); car.topSpeedMph = named("ts") ? parseFloat(named("ts")!) : undefined; car.quarterMile = named("mile") ? parseFloat(named("mile")!) : undefined; car.zeroToSixty = named("a60") ? parseFloat(named("a60")!) : undefined; car.zeroToHundred = named("a100") ? parseFloat(named("a100")!) : undefined; car.braking60 = named("b60") ? parseFloat(named("b60")!) : undefined; car.braking100 = named("b100") ? parseFloat(named("b100")!) : undefined; car.lateralG60 = named("g60") ? parseFloat(named("g60")!) : undefined; car.lateralG120 = named("g120") ? parseFloat(named("g120")!) : undefined;
  }
  const synopsisMatch = content.match(/==Synopsis==\s*([\s\S]*?)(?:\n==|\{\{[A-Z])/);
  if (synopsisMatch) car.synopsis = synopsisMatch[1].replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2").replace(/\{\{[^}]+\}\}/g, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "").replace(/'''([^']+)'''/g, "$1").replace(/''([^']+)''/g, "$1").replace(/\n+/g, " ").trim().slice(0, 500);
  return !car.year && !car.hp && !car.pi ? null : car;
}

export async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  return jsonRecord(await response.json());
}

export async function fetchCarPages(): Promise<string[]> {
  const data = await fetchJson(`${API}?action=parse&page=Forza_Motorsport_(2023)/Cars&prop=wikitext&format=json`);
  const parse = jsonRecord(data.parse);
  const wikitext = String(jsonRecord(parse.wikitext)["*"] ?? "");
  const pageNames = new Set<string>();
  for (const line of wikitext.split("\n")) {
    if (!line.includes("CarListStatsFM23")) continue;
    for (const match of line.matchAll(/\[\[([^\]|#]+)/g)) {
      const page = match[1].trim();
      if (page && !page.startsWith("Category:") && !page.startsWith("File:")) pageNames.add(page);
    }
  }
  return [...pageNames];
}

export async function fetchWikiCars(pageNames: string[]): Promise<WikiCar[]> {
  const cars: WikiCar[] = [];
  for (let i = 0; i < pageNames.length; i += BATCH) {
    const batch = pageNames.slice(i, i + BATCH);
    const titles = batch.map(page => encodeURIComponent(page)).join("|");
    const data = await fetchJson(`${API}?action=query&prop=revisions|images|pageimages&rvprop=content&rvslots=main&imlimit=50&piprop=original&redirects=1&titles=${titles}&format=json&formatversion=2`);
    const pages = Array.isArray(data.query && jsonRecord(data.query).pages) ? jsonRecord(data.query).pages as unknown[] : [];
    let parsed = 0;
    for (const value of pages) {
      const page = jsonRecord(value);
      const revisions = Array.isArray(page.revisions) ? page.revisions : [];
      const revision = jsonRecord(revisions[0]);
      const slots = jsonRecord(revision.slots);
      const content = String(jsonRecord(slots.main)["content"] ?? "");
      if (!content) continue;
      const car = parsePage(content, String(page.title ?? ""));
      if (!car) continue;
      if (car.imageFile?.startsWith("<")) car.imageFile = undefined;
      const pageImages = Array.isArray(page.images) ? page.images.map(image => String(jsonRecord(image).title ?? "").replace(/^File:/, "")) : [];
      const valid = (name: string) => /\.(png|jpg|jpeg|webp)$/i.test(name);
      car.imageFile = pageImages.find(name => /^FM23[\s_]/i.test(name) && valid(name)) ?? pageImages.find(name => /^FH5[\s_]/i.test(name) && valid(name)) ?? pageImages.find(name => /^FH4[\s_]/i.test(name) && valid(name)) ?? (car.imageFile ?? pageImages.find(name => /^F[HM]\d+[\s_]/i.test(name) && valid(name)));
      const original = jsonRecord(page.original);
      if (typeof original.source === "string") car.directImageUrl = original.source;
      cars.push(car); parsed++;
    }
    console.log(` ${parsed}/${batch.length} parsed (${cars.length} total)`);
    if (i + BATCH < pageNames.length) await Bun.sleep(300);
  }
  return cars;
}
