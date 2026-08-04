import { fetchText } from "../../lib/http";
import { GuideSection } from "./types";

const BASE = "https://www.overtake.gg/news/f1-25-track-guides.3245";
const HEADERS = { "User-Agent": "RaceIQ-SetupScraper/1.0 (racing telemetry app)" };
export const TRACK_MAP: Record<string, string> = {
  australia: "page/australia-albert-park.348/", china: "page/china-shanghai-international-circuit.353/", japan: "page/japan-suzuka.354/", bahrain: "page/bahrain-bahrain-international-circuit.352/", saudi_arabia: "page/saudi-arabia-jeddah-corniche-circuit.355/", miami: "page/usa-miami-international-autodrome.356/", imola: "page/italy-autodromo-internazionale-enzo-e-dino-ferrari.351/", monaco: "page/monaco-circuit-de-monaco.357/", spain: "page/spain-barcelona.343/", canada: "page/canada-montr%C3%A9al-circuit-gilles-villeneuve.345/", austria: "page/austria-red-bull-ring.344/", silverstone: "page/great-britian-silverstone.346/", spa: "page/belgium-spa-francorchamps.347/", hungary: "page/hungary-hungaroring.349/", netherlands: "page/netherlands-zandvoort.358/", monza: "page/italy-monza.350/", azerbaijan: "page/azerbaijan-baku.359/", singapore: "page/singapore-marina-bay.360/", usa: "page/usa-circuit-of-the-americas.361/", mexico: "page/mexico-hermanos-rodriguez.362/", brazil: "page/brazil-interlagos.363/", las_vegas: "page/usa-las-vegas-strip-circuit.364/", qatar: "page/qatar-lusail.365/", abudhabi: "page/abu-dhabi-yas-marina.366/",
};

export function parseSections(html: string): GuideSection[] {
  const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "");
  const plain = (fragment: string) => decode(fragment.replace(/<li[^>]*>/gi, "\n• ").replace(/<\/li>/gi, "").replace(/<\/?(strong|em|span|a)[^>]*>/gi, "").replace(/<\/?(p|ul|ol|div|br|h[2-6])[^>]*>/gi, "\n").replace(/<[^>]*>/g, "")).replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const contentStart = html.indexOf('class="bbWrapper"');
  if (contentStart < 0) return [];
  const contentEnd = Math.min(...["Continue Reading", "More in Guides", "class=\"p-article-tag-list\"", "Next page:", "Previous page:", "Last edited:"].map(marker => {
    const index = html.indexOf(marker, contentStart);
    return index > 0 ? index : html.length;
  }));
  const content = html.slice(contentStart, contentEnd);
  const headingRe = /<b>(Sector \d[^<]*)<\/b>|<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi;
  const sections: GuideSection[] = [];
  let lastIdx = 0;
  let pendingHeading = "";
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(content)) !== null) {
    if (pendingHeading) {
      const body = plain(content.slice(lastIdx, match.index));
      if (body.length > 20) sections.push({ heading: pendingHeading, body });
    }
    pendingHeading = decode((match[1] || match[2] || "").replace(/<[^>]*>/g, "")).trim();
    lastIdx = match.index + match[0].length;
  }
  if (pendingHeading) {
    const body = plain(content.slice(lastIdx));
    if (body.length > 20) sections.push({ heading: pendingHeading, body });
  }
  return sections;
}

export async function scrape(slug: string): Promise<GuideSection[]> {
  const pagePath = TRACK_MAP[slug];
  if (!pagePath) return [];
  return parseSections(await fetchText(`${BASE}/${pagePath}`, { headers: HEADERS, retries: 3, retryDelayMs: attempt => 2000 * (attempt + 1) }));
}

export function sourceUrl(slug: string): string {
  return `${BASE}/${TRACK_MAP[slug]}`;
}
