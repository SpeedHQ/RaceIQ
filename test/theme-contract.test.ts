import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const CLIENT_DIR = resolve(import.meta.dir, "../client");
const SOURCE_DIR = resolve(CLIENT_DIR, "src");
const THEME_PATH = resolve(SOURCE_DIR, "styles/theme.css");
const TELEMETRY_PATH = resolve(SOURCE_DIR, "styles/telemetry.css");
const BRANDING_PATH = resolve(SOURCE_DIR, "styles/branding.css");
const OWNED_EXTENSIONS = new Set([".css", ".ts", ".tsx"]);

function ownedSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return ownedSourceFiles(path);
    return OWNED_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

const sourceFiles = ownedSourceFiles(SOURCE_DIR);
const themeCss = readFileSync(THEME_PATH, "utf8");
const telemetryCss = readFileSync(TELEMETRY_PATH, "utf8");
const brandingCss = readFileSync(BRANDING_PATH, "utf8");
const contractCss = [themeCss, telemetryCss, brandingCss].join("\n");

describe("frontend theme contract", () => {
  test("keeps theme, telemetry, and branding tokens in their owning CSS files", () => {
    const definitionPattern = /^\s*(--(?:app|status|dynamics|ch|brand)-[\w-]+)\s*:/gm;
    const misplacedDefinitions = sourceFiles.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(definitionPattern)]
        .filter((match) => {
          const token = match[1];
          const owner =
            token.startsWith("--app-") || token.startsWith("--status-")
              ? THEME_PATH
              : token.startsWith("--dynamics-") || token.startsWith("--ch-")
                ? TELEMETRY_PATH
                : BRANDING_PATH;
          return path !== owner;
        })
        .map((match) => `${path}:${match[0].trim()}`),
    );

    expect(misplacedDefinitions).toEqual([]);
    expect(themeCss).toContain("--app-bg: #000000;");
    expect(themeCss).toContain("--app-text-muted: #999999;");
    expect(themeCss).toContain("--app-text-dim: #777777;");
    expect(themeCss).toContain("--status-success: #34d399;");
    expect(themeCss).toContain("--color-app-text-muted: var(--app-text-muted);");
    expect(themeCss).toContain("--color-app-text-dim: var(--app-text-dim);");
    expect(telemetryCss).toContain("--ch-throttle: #059669;");
    expect(brandingCss).toContain("--brand-game-forza: #00d4ff;");
    expect(brandingCss).toContain("--brand-team-mclaren: #ff8000;");

    const indexCss = readFileSync(resolve(SOURCE_DIR, "index.css"), "utf8");
    for (const file of ["theme", "telemetry", "branding"]) {
      expect(indexCss.match(new RegExp(`@import "\\./styles/${file}\\.css";`, "g"))).toHaveLength(1);
    }
  });

  test("defines every directly consumed theme, telemetry, and branding variable", () => {
    const definitions = new Set([...contractCss.matchAll(/^\s*(--(?:app|status|dynamics|ch|brand)-[\w-]+)\s*:/gm)].map((match) => match[1]));
    const usages = new Set(
      sourceFiles.flatMap((path) => [...readFileSync(path, "utf8").matchAll(/var\((--(?:app|status|dynamics|ch|brand)-[\w-]+)/g)].map((match) => match[1])),
    );

    expect([...usages].filter((token) => !definitions.has(token)).sort()).toEqual([]);
  });

  test("keeps design-tool mirrors aligned with the runtime contract", () => {
    const runtimeColors = new Map([...contractCss.matchAll(/^\s*(--(?:app|status|dynamics|ch)-[\w-]+)\s*:\s*(#[\da-f]+);/gim)].map((match) => [match[1], match[2].toLowerCase()]));
    const designMarkdown = readFileSync(resolve(CLIENT_DIR, "DESIGN.md"), "utf8");
    const documentedColors = [...designMarkdown.matchAll(/^  ([\w-]+): "(#[\da-f]+)"$/gim)];

    expect(documentedColors.length).toBeGreaterThan(0);
    for (const [, name, value] of documentedColors) {
      expect(runtimeColors.get(`--${name}`)).toBe(value.toLowerCase());
    }

    const designMetadata = JSON.parse(readFileSync(resolve(CLIENT_DIR, ".impeccable/design.json"), "utf8")) as {
      extensions: { colorMeta: { surfaceRamp: string[]; textRamp: string[]; statusPalette: Record<string, string> } };
      components: { css: string }[];
    };
    expect(designMetadata.extensions.colorMeta.surfaceRamp).toEqual(["--app-bg", "--app-surface", "--app-surface-alt"].map((token) => runtimeColors.get(token)));
    expect(designMetadata.extensions.colorMeta.textRamp).toEqual(
      ["--app-text", "--app-text-secondary", "--app-text-muted", "--app-text-dim"].map((token) => runtimeColors.get(token)),
    );
    expect(designMetadata.extensions.colorMeta.statusPalette).toEqual(
      Object.fromEntries(["success", "warning", "danger", "info", "unavailable"].map((name) => [name, runtimeColors.get(`--status-${name}`)])),
    );
    expect(designMetadata.components.map((component) => component.css).join("\n")).not.toMatch(/#(?:020617|0f172a|1e293b|334155|f1f5f9|b8c5d4|a0b0c0|7a8ea0)/i);
  });

  test("rejects malformed semantic utilities and the removed one-theme selector", () => {
    const frontendSources = [
      ...sourceFiles.map((path) => readFileSync(path, "utf8")),
      readFileSync(resolve(CLIENT_DIR, ".storybook/preview.ts"), "utf8"),
    ].join("\n");

    expect(frontendSources).not.toMatch(/text-app-text\/90-(?:muted|dim)/);
    expect(frontendSources).not.toContain("data-theme");
    expect(frontendSources).not.toContain("forza-theme");
    expect(frontendSources).not.toContain("ThemeProvider");
  });

  test("keeps product, manufacturer, and team color values out of React", () => {
    const identitySources = [
      "components/HomePage.tsx",
      "components/f1/F1Cars.tsx",
      "components/acc/AccCars.tsx",
      "components/ac-evo/AcEvoCars.tsx",
    ]
      .map((path) => readFileSync(resolve(SOURCE_DIR, path), "utf8"))
      .join("\n");

    expect(identitySources).not.toMatch(/#[\da-f]{3,8}/i);
    expect(identitySources).not.toMatch(/rgba?\(/i);
    expect(identitySources).not.toContain("BRAND_COLORS");
    expect(identitySources).not.toContain("team.color");
  });
});
