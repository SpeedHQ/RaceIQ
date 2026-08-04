import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const CLIENT_DIR = resolve(import.meta.dir, "../../client");
const SOURCE_DIR = resolve(CLIENT_DIR, "src");
const THEME_PATH = resolve(SOURCE_DIR, "styles/theme.css");
const BRANDING_PATH = resolve(SOURCE_DIR, "styles/branding.css");
const OWNED_EXTENSIONS = new Set([".css", ".ts", ".tsx"]);
const CONTRACT_PREFIXES =
  "app|ai|status|severity|operating|tire|ch|comparison|telemetry|metric|visualization|activity|attitude|compass|lap|load|delta|balance|surface|dimension|map|storage|setup|input|review|focus|tune|wireframe|sector|wheel|track|rev|brake|brand";

function ownedSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return ownedSourceFiles(path);
    return OWNED_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

const sourceFiles = ownedSourceFiles(SOURCE_DIR);
const themeCss = readFileSync(THEME_PATH, "utf8");
const brandingCss = readFileSync(BRANDING_PATH, "utf8");
const contractCss = [themeCss, brandingCss].join("\n");
const TYPOGRAPHY_ROLES = [
  "title",
  "heading",
  "body",
  "subtext",
  "detail",
  "label",
  "compact",
  "caption",
  "micro",
  "nano",
  "glyph",
  "visualization-value",
  "visualization-emphasis",
  "instrument-value",
  "instrument-secondary",
  "instrument-primary",
] as const;

function themeHex(token: string): string {
  const value = themeCss.match(new RegExp(`^\\s*${token}:\\s*(#[\\da-f]{6});`, "mi"))?.[1];
  if (!value) throw new Error(`Expected ${token} to use a six-digit hex color`);
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);

  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("frontend theme contract", () => {
  test("keeps theme-controlled tokens together and branding tokens separate", () => {
    const definitionPattern = new RegExp(`^\\s*(--(?:${CONTRACT_PREFIXES})-[\\w-]+)\\s*:`, "gm");
    const misplacedDefinitions = sourceFiles.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(definitionPattern)]
        .filter((match) => {
          const token = match[1];
          const owner = token.startsWith("--brand-") ? BRANDING_PATH : THEME_PATH;
          return path !== owner;
        })
        .map((match) => `${path}:${match[0].trim()}`),
    );

    expect(misplacedDefinitions).toEqual([]);
    for (const token of [
      "--app-bg",
      "--app-surface",
      "--app-surface-alt",
      "--app-surface-hover",
      "--app-progress-track",
      "--app-text-muted",
      "--app-text-dim",
      "--app-on-filled",
      "--status-success",
      "--status-success-hover",
      "--status-danger-hover",
      "--severity-nominal",
      "--operating-cold",
      "--ch-throttle",
      "--comparison-lap-a",
      "--visualization-series-8",
    ]) {
      expect(themeCss).toMatch(new RegExp(`^\\s*${token}:`, "m"));
    }
    expect(themeCss).toContain("--color-app-text-muted: var(--app-text-muted);");
    expect(themeCss).toContain("--color-app-text-dim: var(--app-text-dim);");
    expect(themeCss).not.toContain("--app-surface-2");
    expect(themeCss).not.toContain("--app-panel");
    expect(themeCss).not.toContain("--dynamics-");
    expect(brandingCss).toMatch(/^\s*--brand-game-forza:/m);
    expect(brandingCss).toMatch(/^\s*--brand-team-mclaren:/m);

    const indexCss = readFileSync(resolve(SOURCE_DIR, "index.css"), "utf8");
    for (const file of ["theme", "branding"]) {
      expect(indexCss.match(new RegExp(`@import "\\./styles/${file}\\.css";`, "g"))).toHaveLength(1);
    }
    expect(indexCss).not.toContain("telemetry.css");

    const roleAliasPattern = new RegExp(`^\\s*(--(?:${CONTRACT_PREFIXES})-[\\w-]+)\\s*:\\s*var\\((--(?!color-)[\\w-]+)\\);`, "gm");
    expect([...themeCss.matchAll(roleAliasPattern)].map((match) => `${match[1]} -> ${match[2]}`)).toEqual([]);
  });

  test("defines every directly consumed theme, telemetry, and branding variable", () => {
    const definitionPattern = new RegExp(`^\\s*(--(?:${CONTRACT_PREFIXES})-[\\w-]+)\\s*:`, "gm");
    const usagePattern = new RegExp(`(?:var\\(|-\\()((?:--)(?:${CONTRACT_PREFIXES})-[\\w-]+)`, "g");
    const definitions = new Set([...contractCss.matchAll(definitionPattern)].map((match) => match[1]));
    const usages = new Set(
      sourceFiles.flatMap((path) => [...readFileSync(path, "utf8").matchAll(usagePattern)].map((match) => match[1])),
    );

    expect([...usages].filter((token) => !definitions.has(token)).sort()).toEqual([]);
  });

  test("keeps design-tool mirrors aligned with the runtime contract", () => {
    const designMarkdown = readFileSync(resolve(CLIENT_DIR, "DESIGN.md"), "utf8");
    const documentedColors = [...designMarkdown.matchAll(/^  ([\w-]+): "var\((--[\w-]+)\)"$/gim)];

    expect(documentedColors.length).toBeGreaterThan(0);
    for (const [, name, token] of documentedColors) {
      expect(token).toBe(`--${name}`);
      expect(contractCss).toMatch(new RegExp(`^\\s*${token}:`, "m"));
    }

    const designMetadata = JSON.parse(readFileSync(resolve(CLIENT_DIR, ".impeccable/design.json"), "utf8")) as {
      extensions: {
        colorMeta: { surfaceRamp: string[]; textRamp: string[]; statusPalette: Record<string, string> };
        typographyMeta: { fontFamily: string; monoFamily: string; labelTracking: string; scale: Record<string, string> };
      };
      components: { css: string }[];
    };
    expect(designMetadata.extensions.colorMeta.surfaceRamp).toEqual(["--app-bg", "--app-surface", "--app-surface-alt"].map((token) => `var(${token})`));
    expect(designMetadata.extensions.colorMeta.textRamp).toEqual(
      ["--app-text", "--app-text-secondary", "--app-text-muted", "--app-text-dim"].map((token) => `var(${token})`),
    );
    expect(designMetadata.extensions.colorMeta.statusPalette).toEqual(
      Object.fromEntries(["success", "warning", "danger", "info", "unavailable"].map((name) => [name, `var(--status-${name})`])),
    );
    expect(designMetadata.extensions.typographyMeta.fontFamily).toBe("var(--font-sans)");
    expect(designMetadata.extensions.typographyMeta.monoFamily).toBe("var(--font-mono)");
    expect(designMetadata.extensions.typographyMeta.labelTracking).toBe("var(--tracking-app-label)");
    expect(designMetadata.extensions.typographyMeta.scale).toEqual(Object.fromEntries(TYPOGRAPHY_ROLES.map((role) => [role, `var(--text-app-${role})`])));
    for (const role of TYPOGRAPHY_ROLES) {
      expect(themeCss).toMatch(new RegExp(`^\\s*--text-app-${role}:`, "m"));
      expect(designMarkdown).toContain(`fontSize: "var(--text-app-${role})"`);
    }
    expect(themeCss).toMatch(/^\s*--font-sans:/m);
    expect(themeCss).toMatch(/^\s*--font-mono:/m);
    expect(themeCss).toMatch(/^\s*--tracking-app-label:/m);
    expect(themeCss).not.toContain("--app-font-");
    expect(designMetadata.components.map((component) => component.css).join("\n")).not.toMatch(/#(?:020617|0f172a|1e293b|334155|f1f5f9|b8c5d4|a0b0c0|7a8ea0)/i);
    expect(designMetadata.components.map((component) => component.css).join("\n")).not.toContain(":hover{background:var(--app-surface-alt)");
    const componentTypographyDeclarations = [
      ...designMetadata.components
        .map((component) => component.css)
        .join("\n")
        .matchAll(/\b(font-(?:family|size|weight)):\s*([^;}]+)/g),
    ].map((match) => `${match[1]}:${match[2].trim()}`);
    expect(componentTypographyDeclarations.filter((declaration) => !declaration.includes(":var("))).toEqual([]);
  });

  test("keeps default semantic text and filled controls readable", () => {
    for (const token of ["--app-text", "--app-text-secondary", "--app-text-muted", "--app-text-dim", "--status-unavailable"]) {
      expect(contrastRatio(themeHex(token), themeHex("--app-surface"))).toBeGreaterThanOrEqual(4.5);
    }

    for (const token of ["--app-accent", "--status-success", "--status-warning", "--status-danger", "--status-info"]) {
      expect(contrastRatio(themeHex("--app-on-filled"), themeHex(token))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("rejects malformed semantic utilities", () => {
    const frontendSources = [
      ...sourceFiles.map((path) => readFileSync(path, "utf8")),
      readFileSync(resolve(CLIENT_DIR, ".storybook/preview.ts"), "utf8"),
    ].join("\n");

    expect(frontendSources).not.toMatch(/text-app-text\/90-(?:muted|dim)/);
    expect(frontendSources).not.toContain("forza-theme");
  });

  test("keeps application typography on the shared Tailwind scale", () => {
    const typographySources = sourceFiles
      .filter((path) => path !== THEME_PATH)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(typographySources).not.toMatch(/\btext-\[(?:\d+(?:\.\d+)?px|\d*\.?\d+rem)\]/);
    expect(typographySources).not.toMatch(/\btracking-\[(?:-?\d+(?:\.\d+)?px|-?\d*\.?\d+(?:em|rem))\]/);
    expect(typographySources).not.toMatch(/\bfontFamily\s*=\s*(?:["'](?!var\()|\{\s*["'](?!var\())/);
    expect(typographySources).not.toMatch(/\bfontWeight\s*=\s*(?:["'](?:bold|normal|\d+)["']|\{\d+\})/);
    expect(typographySources).not.toMatch(/\bfontSize\s*:\s*["'`](?!var\()/);
    expect(typographySources).not.toMatch(/\.style\.fontSize\s*=\s*["'][^"']*(?:px|rem)/);
    expect(typographySources).not.toMatch(/["'`](?:bold\s+)?\d+(?:\.\d+)?px\s+(?:(?:ui-)?monospace|system-ui|sans-serif)/i);

    const cssSources = sourceFiles
      .filter((path) => extname(path) === ".css" && path !== THEME_PATH)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(cssSources).not.toMatch(/\bfont-size:\s*(?:\d|\.\d)/);
    expect(cssSources).not.toMatch(/\bfont-family:\s*(?:["']|(?:ui-)?monospace\b|sans-serif\b|Geist\b)/i);
    expect(cssSources).not.toMatch(/\bfont-weight:\s*(?:\d|bold\b|normal\b)/i);
  });

  test("keeps raw palette values in CSS and adapts imperative renderers centrally", () => {
    const canvasAdapterPath = resolve(SOURCE_DIR, "lib/rendering/css-canvas.ts");
    const cssValuesPath = resolve(SOURCE_DIR, "lib/rendering/css-values.ts");
    const runtimeFiles = [
      ...sourceFiles.filter((path) => [".ts", ".tsx"].includes(extname(path)) && path !== canvasAdapterPath),
      resolve(CLIENT_DIR, ".storybook/preview.ts"),
    ];
    const rawColors = runtimeFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const quotedHex = [...source.matchAll(/["'`][^"'`\r\n]*(?<!&)#[\da-f]{3,8}\b/gi)].map((match) => match[0]);
      const colorFunctions = [...source.matchAll(/\b(?:rgb|rgba|hsl|hsla)\s*\(/gi)].map((match) => match[0]);
      const namedColors = [
        ...source.matchAll(
          /\b(?:color|backgroundColor|borderColor|fill|stroke|fillStyle|strokeStyle|shadowColor)\s*(?:=|:)\s*["'`](?:white|black|red|orange|yellow|green|blue|purple|gray|grey)["'`]/gi,
        ),
      ].map((match) => match[0]);
      return [...quotedHex, ...colorFunctions, ...namedColors].map((match) => `${path}:${match}`);
    });

    expect(rawColors).toEqual([]);

    const rawCssColors = sourceFiles
      .filter((path) => extname(path) === ".css" && path !== THEME_PATH && path !== BRANDING_PATH)
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return [...source.matchAll(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\s*\(/gi)].map((match) => `${path}:${match[0]}`);
      });
    expect(rawCssColors).toEqual([]);

    const runtimeSource = runtimeFiles.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(runtimeSource).not.toMatch(/\.getContext\(\s*["']2d["']\s*\)/);
    expect(runtimeSource).not.toMatch(/\bnew\s+THREE\.Color\(\s*(?:0x[\da-f]+|\d+(?:\.\d+)?\s*,)/i);
    expect(runtimeSource).not.toMatch(/<(?:Line|Grid|gridHelper|mesh\w*Material)\b[^>\r\n]*(?:color|args)=\{?[^>\r\n]*["'`]var\(--/);
    expect(runtimeSource).not.toMatch(/var\(--[\w-]+,\s*(?:#[\da-f]{3,8}|rgba?|hsla?)\b/i);
    expect(runtimeSource).not.toMatch(
      /var\(--color-(?:slate|gray|red|orange|amber|yellow|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d+)?\)/i,
    );
    expect(runtimeSource).not.toMatch(
      /\b(?:text|bg|border|ring|stroke|fill|outline|decoration|shadow|from|via|to|accent|divide|placeholder|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d+)?(?:\/\d+)?\b/i,
    );
    expect(runtimeSource).not.toMatch(/var\(--dynamics-(?:green|yellow|amber|orange|red|blue|gray)\)/i);
    expect(runtimeSource).not.toMatch(/\b(?:text|bg|border|ring|stroke|fill)-dynamics-(?:green|yellow|amber|orange|red|blue|gray)\b/i);
    expect(runtimeSource).not.toMatch(/\bCOLOR_VARS\b/);
    expect(runtimeSource).not.toContain("COLORS_HEX");
    expect(runtimeSource).not.toContain("tireTempColorHex");
    expect(runtimeSource).not.toMatch(/\btext-app-(?:bg|surface)\b/);
    expect(runtimeSource).not.toMatch(
      /\bbg-(?:app-accent|status-(?:success|danger|warning|info))(?![\/\w-])[^"'`\r\n]*\btext-app-(?:text|bg|surface)\b/,
    );
    expect(runtimeSource).not.toMatch(
      /\b(?:hover|group-hover):(?:bg-app-(?:bg|surface-alt|surface|border|border-input|text)|border-app-(?:border|border-input|text-dim))(?:\/(?:\d+|\[[^\]]+\]))?(?=["'`\s}])/,
    );

    const canvasAdapterSource = readFileSync(canvasAdapterPath, "utf8");
    const cssValuesSource = readFileSync(cssValuesPath, "utf8");
    expect(canvasAdapterSource).toContain('canvas.getContext("2d")');
    expect(canvasAdapterSource).toContain('property === "font"');
    expect(canvasAdapterSource).toContain("resolveCssFont(value)");
    expect(canvasAdapterSource).not.toMatch(/\bcanvas:\s*OffscreenCanvas\b/);
    expect(canvasAdapterSource).not.toContain("OffscreenCanvasRenderingContext2D");
    expect(cssValuesSource).toContain("getComputedStyle(");
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
