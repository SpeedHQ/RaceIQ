import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { GuideEntry, GuideSection, SrsData, Track } from "./types";

function readJson(path: string, fallback: unknown): unknown {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return fallback; }
}

function arrayFrom(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
}

export async function ensureSourceMeta(outDir: string, sourceSlug: string, name: string, domain: string, url: string): Promise<void> {
  const dir = `${outDir}/${sourceSlug}`;
  mkdirSync(dir, { recursive: true });
  const metaPath = `${dir}/_source.json`;
  if (!existsSync(metaPath)) await Bun.write(metaPath, JSON.stringify({ name, slug: sourceSlug, domain, url, lastScraped: "" }, null, 2));
}

export async function writeTrack(outDir: string, slug: string, track: Track, f1lapsSetups: Record<string, unknown>[], srsData: SrsData, overtakeSections: GuideSection[], overtakeUrl: string | null): Promise<{ f1laps: number; srs: number }> {
  await Bun.write(`${outDir}/${slug}.json`, JSON.stringify({ trackSlug: slug, trackName: track.name, trackOrdinal: track.ordinal }, null, 2));

  const f1lDir = `${outDir}/f1laps/${slug}`;
  mkdirSync(f1lDir, { recursive: true });
  const existingF1L = arrayFrom(readJson(`${f1lDir}/setups.json`, []));
  const existingUrls = new Set(existingF1L.map(setup => setup.source));
  const mergedF1L = [...existingF1L, ...f1lapsSetups.filter(setup => !existingUrls.has(setup.source))];
  await Bun.write(`${f1lDir}/setups.json`, JSON.stringify(mergedF1L, null, 2));

  const srsDir = `${outDir}/simracingsetup/${slug}`;
  mkdirSync(srsDir, { recursive: true });
  const existingSRS = arrayFrom(readJson(`${srsDir}/setups.json`, []));
  const existingSrsUrls = new Set(existingSRS.map(setup => setup.source));
  const mergedSRS = [...existingSRS, ...srsData.setups.filter(setup => !existingSrsUrls.has(setup.source))];
  await Bun.write(`${srsDir}/setups.json`, JSON.stringify(mergedSRS, null, 2));

  const existingMeta = readJson(`${srsDir}/_meta.json`, {});
  const meta = existingMeta && typeof existingMeta === "object" ? existingMeta as Record<string, unknown> : {};
  const existingGuides = Array.isArray(meta.trackGuide) ? meta.trackGuide.filter((guide): guide is GuideEntry => !!guide && typeof guide === "object" && typeof (guide as GuideEntry).source === "string") : [];
  const guideUrl = srsData.guideUrl || (typeof meta.guideUrl === "string" ? meta.guideUrl : "");
  const hasNewGuide = srsData.trackGuide.length > 0 || !!srsData.setupTips || !!srsData.drivingTips;
  if (hasNewGuide) {
    const idx = existingGuides.findIndex(guide => guide.source === guideUrl);
    const previous = existingGuides[idx];
    const entry: GuideEntry = { source: guideUrl, videoUrl: srsData.videoUrl || previous?.videoUrl || "", sections: srsData.trackGuide.length > 0 ? srsData.trackGuide : (previous?.sections ?? []), setupTips: srsData.setupTips || previous?.setupTips || "", drivingTips: srsData.drivingTips || previous?.drivingTips || "" };
    if (idx >= 0) existingGuides[idx] = entry; else existingGuides.push(entry);
  }
  await Bun.write(`${srsDir}/_meta.json`, JSON.stringify({ trackGuide: existingGuides }, null, 2));

  if (overtakeUrl) {
    const overtakeDir = `${outDir}/overtake/${slug}`;
    mkdirSync(overtakeDir, { recursive: true });
    const overtakeMetaPath = `${overtakeDir}/_meta.json`;
    const old = readJson(overtakeMetaPath, {});
    const oldMeta = old && typeof old === "object" ? old as Record<string, unknown> : {};
    const guides = Array.isArray(oldMeta.trackGuide) ? oldMeta.trackGuide.filter((guide): guide is GuideEntry => !!guide && typeof guide === "object" && typeof (guide as GuideEntry).source === "string") : [];
    const idx = guides.findIndex(guide => guide.source === overtakeUrl);
    const previous = guides[idx];
    if (overtakeSections.length > 0 || guides.length === 0) {
      const entry: GuideEntry = { source: overtakeUrl, videoUrl: previous?.videoUrl || "", sections: overtakeSections.length > 0 ? overtakeSections : (previous?.sections ?? []), setupTips: previous?.setupTips || "", drivingTips: previous?.drivingTips || "" };
      if (idx >= 0) guides[idx] = entry; else guides.push(entry);
      await Bun.write(overtakeMetaPath, JSON.stringify({ trackGuide: guides }, null, 2));
    }
  }
  return { f1laps: mergedF1L.length, srs: mergedSRS.length };
}

export async function updateSourceTimestamps(outDir: string, timestamp: string): Promise<void> {
  for (const source of ["f1laps", "simracingsetup", "overtake"]) {
    const path = `${outDir}/${source}/_source.json`;
    const meta = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    meta.lastScraped = timestamp;
    await Bun.write(path, JSON.stringify(meta, null, 2));
  }
}
