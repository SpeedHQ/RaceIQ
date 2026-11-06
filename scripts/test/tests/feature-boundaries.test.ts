import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFeatureBoundaries } from "../check-feature-boundaries";

function fixture(files: Record<string, string>, action: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "raceiq-feature-boundaries-"));
  try {
    const sources = {
      "packages/catalogue/package.json": JSON.stringify({ exports: { "./ui": "./ui/index.ts", "./server": "./server/index.ts", "./contracts": "./contracts/index.ts" } }),
      "packages/catalogue/ui/index.ts": 'export type { Catalogue } from "../contracts/index";',
      "packages/catalogue/server/index.ts": 'import type { Catalogue } from "../contracts/index"; export const catalogue: Catalogue = { id: "1" };',
      "packages/catalogue/contracts/index.ts": "export interface Catalogue { id: string }",
      ...files,
    };
    for (const [path, source] of Object.entries(sources)) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, source);
    }
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("feature browser/server boundaries", () => {
  test("allows separate UI/server entries sharing browser-safe contracts", () => {
    fixture({}, (root) => expect(checkFeatureBoundaries(root, "catalogue")).toEqual([]));
  });

  test("rejects transitive server dependencies through a browser-safe-looking helper", () => {
    fixture({
      "packages/catalogue/ui/index.ts": 'export { metadata } from "./helper";',
      "packages/catalogue/ui/helper.ts": 'export { catalogue as metadata } from "../server/index";',
    }, (root) => {
      expect(checkFeatureBoundaries(root, "catalogue")).toContainEqual(expect.stringContaining("../server/index"));
    });
  });

  test("rejects contracts depending on server modules, including type-only imports", () => {
    fixture({ "packages/catalogue/contracts/index.ts": 'import type { Stats } from "node:fs"; export type Catalogue = Stats;' }, (root) => {
      expect(checkFeatureBoundaries(root, "catalogue")).toContainEqual(expect.stringContaining("node:fs"));
    });
  });

  test("rejects reverse application imports and server-to-UI dependencies", () => {
    fixture({
      "client/src/rpc.ts": "export const rpc = 1;",
      "packages/catalogue/ui/index.ts": 'export { rpc } from "../../../client/src/rpc";',
      "packages/catalogue/server/index.ts": 'export * from "../ui/index";',
    }, (root) => {
      const errors = checkFeatureBoundaries(root, "catalogue");
      expect(errors).toContainEqual(expect.stringContaining("client/src/rpc.ts"));
      expect(errors).toContainEqual(expect.stringContaining("server crosses ownership boundary"));
    });
  });

  test("rejects server loading hidden behind require and dynamic imports", () => {
    fixture({ "packages/catalogue/ui/index.ts": 'const db = require("libsql"); void db; void import("node:fs");' }, (root) => {
      const errors = checkFeatureBoundaries(root, "catalogue");
      expect(errors).toContainEqual(expect.stringContaining("libsql"));
      expect(errors).toContainEqual(expect.stringContaining("node:fs"));
    });
  });

  test("rejects a mixed root barrel even when scoped entries exist", () => {
    fixture({ "packages/catalogue/package.json": JSON.stringify({ exports: { ".": "./index.ts", "./ui": "./ui/index.ts", "./server": "./server/index.ts", "./contracts": "./contracts/index.ts" } }) }, (root) => {
      expect(checkFeatureBoundaries(root, "catalogue")).toContain("catalogue: mixed root/wildcard exports are forbidden");
    });
  });
});
