import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { writeMarketingTrackWallFixture } from "./track-wall-data";
import { removeRuntimeData, reservePorts } from "../ui/lib/process";

const root = resolve(import.meta.dir, "../..");
const buildDir = resolve(root, "client/.tmp/track-wall-storybook");
const outputPath = resolve(root, "assets/marketing/track-wall.html");
const storyUrl = "http://127.0.0.1:0/iframe.html?id=marketing-track-wall--browse-background&viewMode=story";

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "text/html" } });
      if (response.ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("Storybook preview did not become ready");
}

async function replaceRemoteMaps(page: Page): Promise<number> {
  const sources = await page.locator("[data-marketing-track-wall] img").evaluateAll((images) => images.map((image) => image.getAttribute("src")).filter((src): src is string => Boolean(src && /^https?:/.test(src))));
  let failures = 0;
  const results = new Map<string, string | null>();
  for (let offset = 0; offset < sources.length; offset += 12) {
    await Promise.all(sources.slice(offset, offset + 12).map(async (source) => {
      try {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type")?.split(";", 1)[0] || "image/svg+xml";
        results.set(source, `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`);
      } catch {
        failures += 1;
        results.set(source, null);
      }
    }));
  }
  await page.locator("[data-marketing-track-wall] img").evaluateAll((images, replacements) => {
    for (const image of images) {
      const source = image.getAttribute("src");
      const replacement = source ? replacements[source] : undefined;
      if (replacement) image.setAttribute("src", replacement);
      else if (source && /^https?:/.test(source)) image.replaceWith(Object.assign(document.createElement("div"), { className: "flex items-center justify-center h-full text-app-subtext text-app-text-dim", textContent: "No outline available" }));
    }
  }, Object.fromEntries(results));
  return failures;
}

async function inlineStyles(page: Page): Promise<string> {
  const styles = await page.locator("link[rel=stylesheet], style").evaluateAll((nodes) => nodes.map((node) => ({ tag: node.tagName, href: node instanceof HTMLLinkElement ? node.href : null, text: node.textContent || "" })));
  let css = "";
  for (const style of styles) {
    if (style.tag === "STYLE") css += `${style.text}\n`;
    else if (style.href) css += `${await (await fetch(style.href)).text()}\n`;
  }
  const urls = [...css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((match) => match[2]).filter((url) => !url.startsWith("data:") && !url.startsWith("#"));
  const replacements = new Map<string, string>();
  for (const url of urls) {
    try {
      const absolute = new URL(url, page.url()).href;
      const response = await fetch(absolute);
      if (!response.ok) continue;
      const type = response.headers.get("content-type") || "application/octet-stream";
      replacements.set(url, `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`);
    } catch {}
  }
  for (const [url, replacement] of replacements) css = css.replaceAll(`url(${url})`, `url(${replacement})`).replaceAll(`url("${url}")`, `url(${replacement})`).replaceAll(`url('${url}')`, `url(${replacement})`);
  return css;
}

async function main() {
  const fixture = await writeMarketingTrackWallFixture();
  const expectedCount = fixture.tracks.filter((track) => track.mapKind !== "none" && !/\blegacy\b/i.test(`${track.name} ${track.variant} ${track.location}`)).filter((track, index, tracks) => tracks.findIndex((candidate) => candidate.name === track.name) === index).length;
  const viteConfig = resolve(root, "client/.tmp/track-wall-vite.config.mjs");
  await writeFile(viteConfig, `export default { build: { outDir: ${JSON.stringify(buildDir)} } };\n`);
  const [port] = await reservePorts(1);
  let server: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const storybook = resolve(root, "client/node_modules/.bin/storybook");
    const build = Bun.spawn([storybook, "build", "--config-dir", ".storybook", "-o", buildDir], { cwd: resolve(root, "client"), stdout: "inherit", stderr: "inherit" });
    const buildExitCode = await build.exited;
    if (buildExitCode !== 0) throw new Error(`Storybook build failed with exit code ${buildExitCode}`);
    const node = Bun.which("node");
    if (!node) throw new Error("Node.js is required for the Storybook preview");
    server = Bun.spawn([node, resolve(root, "client/node_modules/vite/bin/vite.js"), "preview", "--config", viteConfig, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdout: "inherit", stderr: "inherit" });
    const url = storyUrl.replace(":0", `:${port}`);
    await waitForServer(url);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    const articleCount = await page.locator("[data-marketing-track-wall] article").count();
    if (articleCount !== expectedCount) throw new Error(`Story rendered ${articleCount} articles; expected ${expectedCount}`);
    const failedMaps = await replaceRemoteMaps(page);
    const css = await inlineStyles(page);
    const rootHtml = await page.locator("[data-marketing-track-wall]").evaluate((element) => element.outerHTML);
    const html = `<!-- RaceIQ marketing track wall; synthetic counts; source story marketing-track-wall--browse-background -->\n<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RaceIQ track wall</title><style>${css}</style></head><body>${rootHtml}</body></html>\n`;
    const temporary = `${outputPath}.tmp`;
    await writeFile(temporary, html);
    await rename(temporary, outputPath);
    const checkPage = await browser.newPage();
    await checkPage.goto(`file://${outputPath}`, { waitUntil: "load" });
    const checks = await checkPage.evaluate((expectedCount) => {
      const wall = document.querySelector("[data-marketing-track-wall]");
      const articles = wall?.querySelectorAll("article").length ?? 0;
      const externalAttributes = [...document.querySelectorAll("script, link[rel=stylesheet], [src], [href]")].filter((node) => {
        const value = node.getAttribute("src") || node.getAttribute("href") || "";
        return /^https?:|^\/\//.test(value);
      }).length;
      const externalCss = [...document.querySelectorAll("style")].some((style) => /url\((?!data:|#)/.test(style.textContent || ""));
      const scroller = wall?.querySelector('[tabindex="0"]') as HTMLElement | null;
      const last = wall?.querySelector("article:last-of-type") as HTMLElement | null;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      const viewport = scroller?.getBoundingClientRect();
      const lastRect = last?.getBoundingClientRect();
      const finalVisible = Boolean(viewport && lastRect && lastRect.bottom > viewport.top && lastRect.top < viewport.bottom);
      return { articles, external: externalAttributes + (externalCss ? 1 : 0), gameIds: ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"].every((id) => Boolean(document.querySelector(`[data-game-id="${id}"]`))), overflow: Boolean(scroller && scroller.scrollHeight > scroller.clientHeight), finalVisible, expectedCount };
    }, expectedCount);
    await checkPage.close();
    if (checks.articles !== checks.expectedCount) throw new Error(`Offline export has ${checks.articles} articles; expected ${checks.expectedCount}`);
    if (checks.external !== 0) throw new Error(`Offline export has ${checks.external} external resources`);
    if (!checks.gameIds) throw new Error("Offline export is missing one or more game IDs");
    if (!checks.overflow || !checks.finalVisible) throw new Error("Offline export cannot scroll to the final card");
    await browser.close();
    console.log(`Exported ${articleCount} layouts to ${outputPath}; failed remote maps: ${failedMaps}`);
  } finally {
    server?.kill();
    await removeRuntimeData(buildDir);
    await rm(`${outputPath}.tmp`, { force: true });
    await rm(viteConfig, { force: true });
  }
}

if (import.meta.main) await main();
