import { createReadStream, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const assetRoots = [
  { match: "car-images/f1/", urlRoot: "car-images/f1", source: "packages/game-f1-2025/assets/public/car-images/f1", filePrefix: "" },
  { match: "car-images/acc-", urlRoot: "car-images", source: "packages/game-acc/assets/public/car-images", filePrefix: "acc-" },
  { match: "car-images/", urlRoot: "car-images", source: "packages/game-fm-2023/assets/public/car-images", filePrefix: "" },
  { match: "iracing-car-images/", urlRoot: "iracing-car-images", source: "packages/game-iracing/assets/public/iracing-car-images", filePrefix: "" },
] as const;

export function gameImagesPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "raceiq-game-images",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url) return next();
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        } catch {
          response.statusCode = 400;
          response.end("Bad request");
          return;
        }
        const mapping = assetRoots.find(({ match }) => pathname.startsWith(`/${match}`));
        if (!mapping) return next();
        const root = path.resolve(REPOSITORY_ROOT, mapping.source);
        const relative = `${mapping.filePrefix}${pathname.slice(mapping.match.length + 1)}`;
        const file = path.resolve(root, relative);
        if (!file.startsWith(`${root}${path.sep}`)) {
          response.statusCode = 404;
          response.end("Not found");
          return;
        }
        try {
          if (!statSync(file).isFile()) return next();
        } catch {
          return next();
        }
        response.statusCode = 200;
        response.setHeader("content-type", file.endsWith(".webp") ? "image/webp" : file.endsWith(".png") ? "image/png" : "image/jpeg");
        createReadStream(file).pipe(response);
      });
    },
    configResolved(resolved) {
      config = resolved;
    },
    writeBundle(outputOptions) {
      const outDir = path.resolve(config.root, outputOptions.dir ?? config.build.outDir);
      for (const mapping of assetRoots) {
        const sourceRoot = path.resolve(REPOSITORY_ROOT, mapping.source);
        if (!statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) continue;
        const targetRoot = path.resolve(outDir, mapping.urlRoot);
        mkdirSync(targetRoot, { recursive: true });
        const copy = (source: string, target: string): void => {
          for (const entry of readdirSync(source, { withFileTypes: true })) {
            const sourcePath = path.join(source, entry.name);
            const targetPath = path.join(target, entry.name);
            if (entry.isDirectory()) {
              mkdirSync(targetPath, { recursive: true });
              copy(sourcePath, targetPath);
            } else if (entry.isFile()) {
              copyFileSync(sourcePath, targetPath);
            }
          }
        };
        copy(sourceRoot, targetRoot);
      }
    },
  };
}
