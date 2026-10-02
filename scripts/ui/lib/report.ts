import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ScreenshotDiff } from "../collect-screenshot-diffs";

export interface UiDiffMetadata {
  generatedAt: string;
  baseRef: string;
  baseSha: string | null;
  currentSha: string | null;
  dirtyFiles: string[];
  partial: boolean;
  errors: string[];
}

interface ReportChange extends ScreenshotDiff {
  viewport: string;
  beforePath: string;
  afterPath: string;
  diffPath: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.001 ? 3 : 2)}%`;
}

function reportChanges(changes: ScreenshotDiff[]): ReportChange[] {
  return changes.map((change) => ({
    ...change,
    viewport:
      change.prefix === "responsive"
        ? change.relativePath.split("/")[0] || "unknown"
        : "storybook",
    beforePath: `images/${change.beforeFile}`,
    afterPath: `images/${change.afterFile}`,
    diffPath: `images/${change.diffFile}`,
  }));
}

export async function writeUiDiffReport(
  reportDir: string,
  metadata: UiDiffMetadata,
  changes: ScreenshotDiff[],
): Promise<string> {
  mkdirSync(reportDir, { recursive: true });
  const prepared = reportChanges(changes);
  const counts = {
    total: prepared.length,
    changed: prepared.filter((change) => change.status === "changed").length,
    added: prepared.filter((change) => change.status === "added").length,
    removed: prepared.filter((change) => change.status === "removed").length,
  };
  const report = { metadata, counts, changes: prepared };
  await Bun.write(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const viewports = [...new Set(prepared.map((change) => change.viewport))].sort();
  const cards = prepared
    .map((change) => {
      const detail =
        change.status === "changed" && change.differingPixels === 0 && change.pixelRatio === 1
          ? "dimensions changed"
          : `${percent(change.pixelRatio)} pixels changed`;
      return `
        <article class="card" data-status="${change.status}" data-viewport="${escapeHtml(change.viewport)}" data-path="${escapeHtml(change.relativePath.toLowerCase())}">
          <header>
            <span class="badge ${change.status}">${change.status}</span>
            <h2>${escapeHtml(change.relativePath)}</h2>
            <span class="detail">${escapeHtml(detail)} · ${change.width}×${change.height}</span>
          </header>
          <div class="triptych">
            <figure><figcaption>Before</figcaption><a href="${escapeHtml(change.beforePath)}"><img src="${escapeHtml(change.beforePath)}" alt="Before ${escapeHtml(change.relativePath)}"></a></figure>
            <figure><figcaption>After</figcaption><a href="${escapeHtml(change.afterPath)}"><img src="${escapeHtml(change.afterPath)}" alt="After ${escapeHtml(change.relativePath)}"></a></figure>
            <figure><figcaption>Diff</figcaption><a href="${escapeHtml(change.diffPath)}"><img src="${escapeHtml(change.diffPath)}" alt="Diff ${escapeHtml(change.relativePath)}"></a></figure>
          </div>
          <details>
            <summary>Overlay comparison</summary>
            <div class="overlay" style="--split: 50%">
              <img src="${escapeHtml(change.beforePath)}" alt="">
              <img class="overlay-after" src="${escapeHtml(change.afterPath)}" alt="">
            </div>
            <input class="split" type="range" min="0" max="100" value="50" aria-label="Before and after split">
          </details>
        </article>`;
    })
    .join("\n");

  const errorPanel =
    metadata.errors.length > 0
      ? `<section class="errors"><h2>Partial comparison</h2><p>Missing captures are not classified as added or removed.</p><ul>${metadata.errors
          .map((error) => `<li><pre>${escapeHtml(error)}</pre></li>`)
          .join("")}</ul></section>`
      : "";
  const emptyState =
    prepared.length === 0
      ? `<section class="empty"><h2>${metadata.partial ? "No comparable differences collected" : "No material UI differences"}</h2><p>${metadata.partial ? "Fix capture errors above, then rerun." : "Current responsive screenshots match baseline within configured tolerance."}</p></section>`
      : "";
  const dirtyLabel =
    metadata.dirtyFiles.length > 0
      ? `${metadata.dirtyFiles.length} dirty path${metadata.dirtyFiles.length === 1 ? "" : "s"}`
      : "clean HEAD";
  const viewportOptions = viewports
    .map((viewport) => `<option value="${escapeHtml(viewport)}">${escapeHtml(viewport)}</option>`)
    .join("");
  const serialisedReport = JSON.stringify(report).replaceAll("<", "\\u003c");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RaceIQ local UI diff</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #090d14; color: #edf2f7; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1800px, 100%); margin: auto; padding: 24px; }
    .hero { display: flex; flex-wrap: wrap; gap: 20px; align-items: end; justify-content: space-between; margin-bottom: 20px; }
    h1 { margin: 0 0 6px; font-size: clamp(24px, 4vw, 40px); }
    .meta { color: #94a3b8; margin: 3px 0; font-family: ui-monospace, monospace; font-size: 13px; }
    .counts { display: flex; flex-wrap: wrap; gap: 8px; }
    .count, .badge { border-radius: 999px; padding: 6px 10px; background: #172033; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    .controls { position: sticky; top: 0; z-index: 5; display: grid; grid-template-columns: minmax(220px, 1fr) repeat(2, minmax(130px, 220px)); gap: 10px; padding: 12px; margin: 0 0 18px; background: rgb(9 13 20 / 92%); backdrop-filter: blur(10px); border: 1px solid #243047; border-radius: 12px; }
    input, select { width: 100%; border: 1px solid #334155; border-radius: 8px; background: #111827; color: inherit; padding: 9px 11px; }
    .card { border: 1px solid #243047; border-radius: 14px; background: #0f1623; padding: 16px; margin-bottom: 20px; box-shadow: 0 18px 50px rgb(0 0 0 / 18%); }
    .card header { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .card h2 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
    .detail { color: #94a3b8; margin-left: auto; font-size: 12px; }
    .badge { font-weight: 700; padding: 4px 8px; }
    .badge.changed { background: #78350f; color: #fde68a; }
    .badge.added { background: #064e3b; color: #a7f3d0; }
    .badge.removed { background: #7f1d1d; color: #fecaca; }
    .triptych { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    figure { margin: 0; min-width: 0; }
    figcaption { color: #cbd5e1; font-size: 12px; margin: 0 0 6px; }
    figure img, .overlay img { width: 100%; height: auto; display: block; border-radius: 6px; background: #111827; }
    details { margin-top: 12px; }
    summary { cursor: pointer; color: #93c5fd; }
    .overlay { display: grid; position: relative; margin-top: 10px; overflow: hidden; border-radius: 6px; }
    .overlay img { grid-area: 1 / 1; }
    .overlay-after { clip-path: inset(0 calc(100% - var(--split)) 0 0); }
    .split { margin-top: 8px; padding: 0; }
    .errors, .empty { border: 1px solid #7f1d1d; background: #2a1116; border-radius: 12px; padding: 16px; margin-bottom: 18px; }
    .empty { border-color: #1e3a5f; background: #0d1d2f; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0; }
    [hidden] { display: none !important; }
    @media (max-width: 900px) { main { padding: 14px; } .controls { grid-template-columns: 1fr; position: static; } .triptych { grid-template-columns: 1fr; } .detail { margin-left: 0; width: 100%; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <h1>RaceIQ local UI diff</h1>
        <p class="meta">Base: ${escapeHtml(metadata.baseRef)} · ${escapeHtml(metadata.baseSha?.slice(0, 12) ?? "unavailable")}</p>
        <p class="meta">Current: ${escapeHtml(metadata.currentSha?.slice(0, 12) ?? "unavailable")} · ${escapeHtml(dirtyLabel)}</p>
        <p class="meta">Generated: ${escapeHtml(metadata.generatedAt)}</p>
      </div>
      <div class="counts">
        <span class="count">${counts.total} total</span>
        <span class="count">${counts.changed} changed</span>
        <span class="count">${counts.added} added</span>
        <span class="count">${counts.removed} removed</span>
      </div>
    </section>
    ${errorPanel}
    <section class="controls" aria-label="Report filters">
      <input id="search" type="search" placeholder="Filter screenshot path">
      <select id="status"><option value="">All statuses</option><option value="changed">Changed</option><option value="added">Added</option><option value="removed">Removed</option></select>
      <select id="viewport"><option value="">All viewports</option>${viewportOptions}</select>
    </section>
    ${emptyState}
    <section id="cards">${cards}</section>
  </main>
  <script type="application/json" id="report-data">${serialisedReport}</script>
  <script>
    const search = document.querySelector("#search");
    const status = document.querySelector("#status");
    const viewport = document.querySelector("#viewport");
    const cards = [...document.querySelectorAll(".card")];
    function filter() {
      const query = search.value.trim().toLowerCase();
      for (const card of cards) {
        card.hidden = Boolean(
          (query && !card.dataset.path.includes(query)) ||
          (status.value && card.dataset.status !== status.value) ||
          (viewport.value && card.dataset.viewport !== viewport.value)
        );
      }
    }
    search.addEventListener("input", filter);
    status.addEventListener("change", filter);
    viewport.addEventListener("change", filter);
    for (const slider of document.querySelectorAll(".split")) {
      slider.addEventListener("input", () => slider.previousElementSibling.style.setProperty("--split", slider.value + "%"));
    }
  </script>
</body>
</html>`;

  const reportPath = join(reportDir, "index.html");
  await Bun.write(reportPath, html);
  return reportPath;
}
