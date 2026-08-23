import { turnNumbers } from "../../../shared/racing/tracks/segment-label";
import type { CornerFact, TrackFacts } from "../../../shared/racing/tracks/facts";
import { productionTrackGuideStore } from "../../../shared/racing/tracks/guide/data";
import { loadTrackFacts } from "../../../shared/racing/tracks/storage/meta";

export type Corner = CornerFact;
export type Facts = Pick<TrackFacts, "corners">;
export const numsOf = (c: Corner) => turnNumbers({ number: c.number, covers: c.covers });
export function loadFacts(slug: string): Facts | null {
  return loadTrackFacts(slug);
}
export function knownTurns(facts: Facts): Set<number> {
  const out = new Set<number>();
  for (const c of facts.corners ?? []) for (const n of numsOf(c)) out.add(n);
  return out;
}
export type GuideAnchor = { slug: string; name: string; numbers: number[] };
export function guideAnchors(): GuideAnchor[] {
  const out: GuideAnchor[] = [];
  for (const slug of productionTrackGuideStore.list()) {
    const guide = productionTrackGuideStore.load(slug);
    if (!guide) continue;
    for (const c of guide.corners) if (c.numbers?.length) out.push({ slug, name: c.name, numbers: c.numbers });
  }
  return out;
}
export const KNOWN_ANCHOR_GAPS: Record<string, string[]> = {
  "mount-panorama": ["Mountain Straight", "Conrod Straight"],
  montreal: ["Wall of Champions"],
  interlagos: ["Subida dos Boxes"],
  valencia: ["Turn 9", "Turn 12"],
  misano: ["Tramonto"],
  nurburgring: ["Bit-Kurve", "Veedol"],
  nordschleife: ["Fuchsröhre", "Döttinger Höhe"],
  catalunya: ["Turn 12-13", "Turn 14-15"],
  fuji: ["TGR Corner", "Coca-Cola Corner", "Toyopet 100R", "Advan Corner", "300R", "Dunlop Corner", "GR Supra Corner", "Panasonic Corner"],
  "yas-marina": ["Hotel Corners", "Marina Section"],
  hockenheim: ["Motodrom", "Turn 6"],
  "mid-ohio": ["Madness", "Thunder Valley", "Carousel"],
  zolder: ["Kanaalbocht", "Butte"],
  kyalami: ["The Kink", "Crowthorne"],
  snetterton: ["Wilson"],
  "lime-rock": ["Righthander (No Name Straight approach)"],
  "paul-ricard": ["Mistral Straight Chicane"],
  indianapolis: ["Turn 16"],
  sochi: ["Turn 2", "Turn 3", "Turn 4", "Turn 12-13"],
  portimao: ["Primeira", "Turn 4", "Torre Vip", "Turn 15"],
  hanoi: ["Turn 1", "Turn 6-9", "Turn 11"],
};
export const FANTASY_SLUGS = new Set(["maple-valley", "fujimi-kaido", "sunset-peninsula", "grand-oak", "hakone", "eaglerock"]);
export function unanchoredEntries(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const slug of productionTrackGuideStore.list()) {
    if (FANTASY_SLUGS.has(slug)) continue;
    const guide = productionTrackGuideStore.load(slug);
    if (!guide) continue;
    for (const c of guide.corners) {
      if (c.numbers?.length) continue;
      out[slug] ??= [];
      out[slug].push(c.name);
    }
  }
  return out;
}
export const KNOWN_MERGES: Record<string, string[][]> = {
  spa: [["Eau Rouge", "Raidillon"]],
  silverstone: [["Maggotts", "Becketts"]],
  suzuka: [
    ["First Curve", "Second Curve"],
    ["Degner 1", "Degner 2"],
  ],
  imola: [["Rivazza 1", "Rivazza 2"]],
  zandvoort: [["Turn 8", "Turn 9"]],
  "mount-panorama": [["Skyline", "The Esses", "The Dipper"]],
  monaco: [["Rascasse", "Antony Noghes"]],
  baku: [["Castle Section", "Turn 8"]],
  "road-atlanta": [["Turn 10a", "Turn 10b"]],
};
export type GuideEntry = { slug: string; name: string; numbers: number[]; type: string };
export function guideEntries(): GuideEntry[] {
  const out: GuideEntry[] = [];
  for (const slug of productionTrackGuideStore.list()) {
    const guide = productionTrackGuideStore.load(slug);
    if (!guide) continue;
    for (const c of guide.corners) if (c.numbers?.length) out.push({ slug, name: c.name, numbers: c.numbers, type: c.type });
  }
  return out;
}
export const KNOWN_NUMBERING_CONFLICTS = ["brands-hatch :: Clark Curve", "nurburgring :: Dunlop Kehre", "nurburgring :: NGK Chicane", "suzuka :: Degner 2", "suzuka :: Dunlop Curve"];
export const KNOWN_OUT_OF_ORDER = ["misano :: Curvone -> Quercia", "mugello :: Arrabbiata 1 & 2 -> Casanova-Savelli", "snetterton :: Coram -> Palmer"];
