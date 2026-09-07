import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

/**
 * THESIS: RaceIQ marketing proves lap intelligence through real product surfaces, never generic benefit cards.
 * OWN-WORLD: Flat near-black cockpit panels, one cyan signal, hairline borders, dense calibrated telemetry.
 * STORY: See the lap in motion, verify a controlled experiment, then understand the product's full review loop.
 * FIRST VIEWPORT: One decisive product surface fills most of each 16:9 frame; copy occupies a fixed instrument rail.
 * FORM: Approved motion hero, experiment proof, and product mosaic; staged as source-backed 1920×1080 assets.
 */

const root = resolve(import.meta.dir, "../..");
const screenshotDir = resolve(root, "assets/screenshots");
const outputDir = resolve(root, "assets/marketing");
const viewport = { width: 1920, height: 1080 };

const mimeByExtension: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

async function imageDataUrl(path: string): Promise<string> {
  const mime = mimeByExtension[extname(path).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image type: ${path}`);
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
}

const css = String.raw`
  :root {
    color-scheme: dark;
    --bg: #050607;
    --surface: #090c0f;
    --surface-alt: #10151a;
    --surface-hover: #161d23;
    --border: #273139;
    --border-strong: #3a4650;
    --text: #f2f6f8;
    --text-secondary: #aeb9c0;
    --text-muted: #77848d;
    --text-dim: #53606a;
    --accent: #1fc7dc;
    --nominal: #40d6a6;
    --warning: #e6ba55;
    --critical: #ef6671;
    --font-sans: "Geist Variable", "Avenir Next", "Segoe UI", sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--bg); }
  body { color: var(--text); font-family: var(--font-sans); }
  .stage { position: relative; width: 100vw; height: 100vh; min-width: 960px; min-height: 540px; overflow: hidden; background: var(--bg); }
  .brand { font-size: 24px; font-weight: 740; letter-spacing: -0.045em; }
  .utility { font: 650 13px/1.2 var(--font-mono); letter-spacing: .13em; text-transform: uppercase; color: var(--text-muted); }
  .copy { color: var(--text-secondary); font-size: 20px; line-height: 1.45; max-width: 33rem; }
  h1 { margin: 0; max-width: 850px; font-size: clamp(58px, 5.1vw, 98px); font-weight: 720; line-height: .96; letter-spacing: -.045em; text-wrap: balance; }
  .signal { width: 66px; height: 3px; background: var(--accent); }
  .frame { overflow: hidden; border: 1px solid var(--border); background: var(--surface); }
  .frame img { width: 100%; height: 100%; display: block; object-fit: cover; }
  .frame-label { position: absolute; z-index: 3; top: 0; left: 0; padding: 10px 13px; background: var(--surface-alt); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); font: 650 12px/1 var(--font-mono); letter-spacing: .11em; color: var(--text-secondary); }
  .data-cell { min-width: 0; padding: 18px 20px; border: 1px solid var(--border); background: var(--surface); }
  .data-cell span { display: block; margin-bottom: 8px; font: 650 12px/1 var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--text-muted); }
  .data-cell strong { display: block; font: 700 29px/1 var(--font-mono); color: var(--text); }
  .data-cell strong.nominal { color: var(--nominal); }
  .data-cell small { display: block; margin-top: 7px; color: var(--text-dim); font: 12px/1.2 var(--font-mono); }
  .synthetic { display: inline-flex; align-items: center; gap: 8px; color: var(--text-muted); font: 650 11px/1 var(--font-mono); letter-spacing: .1em; text-transform: uppercase; }
  .synthetic::before { content: ""; width: 7px; height: 7px; background: var(--warning); }
  @media (prefers-reduced-motion: reduce) { video { display: none; } }
`;

function html(title: string, contract: string, body: string, extraCss: string): string {
  return `<!-- ${contract} -->\n<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<meta name="color-scheme" content="dark">\n<title>${title}</title>\n<style>${css}${extraCss}</style>\n</head>\n<body>${body}</body>\n</html>\n`;
}

function motionHero(poster: string): string {
  const contract =
    "THESIS: Replay the lap at full scale, not inside a device mockup. OWN-WORLD: Flat cockpit rail and one cyan playhead. STORY: 3D replay reveals where time went. FIRST VIEWPORT: Copy rail left, native render right. FORM: Approved A / motion hero.";
  return html(
    "RaceIQ — See the lap. Find the time.",
    contract,
    `<main class="stage motion">
      <section class="motion-copy" aria-label="RaceIQ lap intelligence">
        <div class="brand">RaceIQ</div>
        <div class="motion-main">
          <div class="utility">Multi-sim lap intelligence</div>
          <div class="signal" aria-hidden="true"></div>
          <h1>See the lap.<br>Find the time.</h1>
          <p class="copy">Replay the racing line in 3D. Compare every input. Leave with a corner-specific next action.</p>
        </div>
        <div class="motion-footer">
          <span>Las Vegas</span><span>3D replay</span><span>60 fps</span>
        </div>
      </section>
      <section class="motion-visual" aria-label="RaceIQ 3D lap replay">
        <img src="${poster}" alt="RaceIQ three-dimensional lap analysis">
        <video autoplay muted loop playsinline poster="${poster}" aria-label="RaceIQ 3D lap replay recording">
          <source src="../demo-render.webm" type="video/webm">
          <source src="../demo-render.mp4" type="video/mp4">
        </video>
        <div class="motion-marker"><span>T14</span><strong>Brake release</strong><small>4.6 tenths available</small></div>
        <div class="playhead" aria-hidden="true"></div>
        <div class="visual-caption utility">Las Vegas · Lap 5 · 1:19.328</div>
      </section>
    </main>`,
    String.raw`
      .motion { display: grid; grid-template-columns: 31% 69%; }
      .motion-copy { position: relative; z-index: 3; display: flex; flex-direction: column; padding: 42px 50px 35px; border-right: 1px solid var(--accent); background: var(--bg); }
      .motion-main { display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 28px; }
      .motion-main h1 { font-size: clamp(64px, 5.6vw, 108px); }
      .motion-footer { display: flex; gap: 0; border-top: 1px solid var(--border); color: var(--text-muted); font: 650 12px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
      .motion-footer span { padding: 15px 20px 0 0; margin-right: 20px; border-right: 1px solid var(--border); }
      .motion-visual { position: relative; overflow: hidden; background: #000; }
      .motion-visual > img, .motion-visual > video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 58% center; }
      .motion-visual > video { z-index: 1; }
      .motion-marker { position: absolute; z-index: 4; top: 17%; right: 5%; width: 238px; padding: 16px 18px; border: 1px solid var(--border-strong); background: var(--surface); }
      .motion-marker span { float: left; margin-right: 12px; color: var(--accent); font: 700 15px/1 var(--font-mono); }
      .motion-marker strong, .motion-marker small { display: block; }
      .motion-marker strong { font-size: 15px; }
      .motion-marker small { margin-top: 6px; color: var(--text-muted); font: 12px/1.2 var(--font-mono); }
      .playhead { position: absolute; z-index: 3; top: 0; bottom: 0; left: 58%; width: 1px; background: var(--accent); opacity: .65; }
      .visual-caption { position: absolute; z-index: 4; right: 24px; bottom: 22px; padding: 12px 14px; border: 1px solid var(--border); background: var(--surface); color: var(--text-secondary); }
    `,
  );
}

function experimentProof(screenshot: string): string {
  const contract =
    "THESIS: Show a controlled experiment producing readable evidence, not a feature claim. OWN-WORLD: Flat review canvas, telemetry cells, one cyan signal. STORY: Change one variable and judge the outcome. FIRST VIEWPORT: Real review surface left, conclusion rail right. FORM: Approved C / experiment proof.";
  return html(
    "RaceIQ — Change one thing. Know if it worked.",
    contract,
    `<main class="stage experiment">
      <header class="experiment-header">
        <div class="brand">RaceIQ</div>
        <div class="utility">Experiment review / post-lap evidence</div>
        <div class="synthetic">Synthetic demo data</div>
      </header>
      <section class="experiment-screen frame">
        <div class="frame-label">TRACK FOCUS · ALL LAPS</div>
        <img src="${screenshot}" alt="RaceIQ experiment review with populated telemetry">
      </section>
      <aside class="experiment-copy">
        <div class="utility">Test. learn. improve.</div>
        <div class="signal" aria-hidden="true"></div>
        <h1>Change one thing.<br>Know if it worked.</h1>
        <p class="copy">Compare clean laps, surface handling issues, and verify whether the change improved pace or consistency.</p>
        <div class="evidence">
          <div class="data-cell"><span>Best lap</span><strong class="nominal">1:19.328</strong><small>Fastest valid lap</small></div>
          <div class="data-cell"><span>Consistency</span><strong>73%</strong><small>Across evaluation laps</small></div>
          <div class="data-cell"><span>Valid laps</span><strong>5 / 5</strong><small>Ready to compare</small></div>
          <div class="data-cell"><span>Issues</span><strong>28</strong><small>Located by corner</small></div>
        </div>
      </aside>
    </main>`,
    String.raw`
      .experiment { display: grid; grid-template-columns: 66% 34%; grid-template-rows: 82px 1fr; gap: 0; }
      .experiment-header { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 34px; padding: 0 42px; border-bottom: 1px solid var(--border); background: var(--surface); }
      .experiment-screen { position: relative; margin: 34px 0 34px 34px; }
      .experiment-screen img { object-position: left center; }
      .experiment-copy { display: flex; flex-direction: column; justify-content: center; gap: 25px; padding: 50px 48px; border-left: 1px solid var(--border); background: var(--bg); }
      .experiment-copy h1 { font-size: clamp(52px, 4.1vw, 80px); }
      .evidence { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
    `,
  );
}

function productMosaic(home: string, compare: string, analyse: string): string {
  const contract =
    "THESIS: Product breadth reads as one connected pit-wall system, not a stack of feature cards. OWN-WORLD: Cropped instrument panes divided by a cyan signal spine. STORY: Review the session, compare laps, then diagnose the corner. FIRST VIEWPORT: Three real surfaces share one asymmetric data wall. FORM: Approved D / product mosaic.";
  return html(
    "RaceIQ — One view of every racing decision.",
    contract,
    `<main class="stage mosaic">
      <header class="mosaic-header">
        <div class="brand">RaceIQ</div>
        <h1>One view of every racing decision.</h1>
        <p>Session history, lap comparison, and 3D analysis share one calibrated workspace.</p>
      </header>
      <section class="pane pane-home frame"><div class="frame-label">SESSION OVERVIEW</div><img src="${home}" alt="RaceIQ session overview"></section>
      <section class="pane pane-compare frame"><div class="frame-label">LAP COMPARISON</div><img src="${compare}" alt="RaceIQ lap comparison"></section>
      <section class="pane pane-analyse frame"><div class="frame-label">3D LAP ANALYSIS</div><img src="${analyse}" alt="RaceIQ three-dimensional lap analysis"></section>
      <div class="mosaic-spine" aria-hidden="true"></div>
      <footer class="mosaic-footer">
        <span>Forza Motorsport</span><span>F1 2025</span><span>Assetto Corsa Competizione</span><span>Assetto Corsa EVO</span><span>iRacing</span>
      </footer>
    </main>`,
    String.raw`
      .mosaic { display: grid; grid-template-columns: 44% 56%; grid-template-rows: 178px 1fr 1fr 54px; gap: 9px; padding: 30px; }
      .mosaic-header { grid-column: 1 / -1; display: grid; grid-template-columns: 180px 1fr 420px; align-items: end; gap: 34px; padding: 0 0 28px; border-bottom: 1px solid var(--border); }
      .mosaic-header h1 { font-size: clamp(48px, 4.4vw, 84px); }
      .mosaic-header p { margin: 0 0 5px; color: var(--text-secondary); font-size: 18px; line-height: 1.45; }
      .pane { position: relative; min-height: 0; }
      .pane-home { grid-column: 1; grid-row: 2; }
      .pane-compare { grid-column: 1; grid-row: 3; }
      .pane-analyse { grid-column: 2; grid-row: 2 / 4; }
      .pane-home img { object-position: 14% 18%; transform: scale(1.02); }
      .pane-compare img { object-position: 18% 36%; transform: scale(1.04); }
      .pane-analyse img { object-position: 57% center; transform: scale(1.02); }
      .mosaic-spine { position: absolute; top: 208px; bottom: 84px; left: calc(44% + 29px); width: 1px; background: var(--accent); z-index: 4; }
      .mosaic-footer { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); font: 650 12px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
    `,
  );
}

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const [poster, experiment, home, compare, analyse] = await Promise.all([
    imageDataUrl(resolve(screenshotDir, "lap-analytics.png")),
    imageDataUrl(resolve(screenshotDir, "experiments-review-track.png")),
    imageDataUrl(resolve(screenshotDir, "home.png")),
    imageDataUrl(resolve(screenshotDir, "compare.png")),
    imageDataUrl(resolve(screenshotDir, "lap-analytics.png")),
  ]);

  const assets = [
    { name: "motion-hero", document: motionHero(poster) },
    { name: "experiment-proof", document: experimentProof(experiment) },
    { name: "product-mosaic", document: productMosaic(home, compare, analyse) },
  ];

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport });
    for (const asset of assets) {
      const htmlPath = resolve(outputDir, `${asset.name}.html`);
      const imagePath = resolve(outputDir, `${asset.name}.png`);
      await writeFile(htmlPath, asset.document);
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
      if (asset.name === "motion-hero") {
        await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 2, undefined, { timeout: 15_000 });
        await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
          video.currentTime = 2;
          if (video.seeking) await new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
          video.pause();
        });
      }
      await page.screenshot({ path: imagePath, type: "png", animations: "disabled" });
      console.log(`Wrote assets/marketing/${asset.name}.{html,png}`);
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.main) await main();
