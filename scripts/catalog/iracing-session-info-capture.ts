import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareCatalogStrings } from "./contract-inference";

export interface IRacingSessionInfoCapture {
  fileName: string;
  leafPaths: readonly string[];
}

export interface IRacingSessionInfoCaptureManifest {
  format: "raceiq-iracing-session-info-paths-v1";
  source: {
    url: string;
    commit: string;
    license: string;
    licenseUrl?: string;
    copyright?: string;
  };
  leafPaths: string[];
}

export interface IRacingSessionInfoCatalogEntry {
  path: string;
  unit: string;
  description: string;
}

function collectLeafPaths(
  value: unknown,
  path: string,
  root: boolean,
  leaves: Set<string>,
): void {
  if (Array.isArray(value)) {
    // Bun returns a top-level array when a capture contains YAML documents or
    // snapshots. That container is not part of SessionInfo; nested sequences
    // are schema-bearing and therefore retain the normalized [] marker.
    const itemPath = root ? path : `${path}[]`;
    for (const item of value) collectLeafPaths(item, itemPath, false, leaves);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectLeafPaths(child, path ? `${path}.${key}` : key, false, leaves);
    }
    return;
  }
  if (path) leaves.add(path);
}

/** Enumerate scalar and null leaves, collapsing every nested sequence to `[]`. */
export function collectIRacingSessionInfoLeafPaths(yaml: string): string[] {
  const leaves = new Set<string>();
  collectLeafPaths(Bun.YAML.parse(yaml), "", true, leaves);
  return [...leaves].sort();
}

function parseManifest(
  fileName: string,
  value: unknown,
): IRacingSessionInfoCapture {
  const manifest = value as Partial<IRacingSessionInfoCaptureManifest>;
  if (
    manifest?.format !== "raceiq-iracing-session-info-paths-v1" ||
    !manifest.source ||
    typeof manifest.source.url !== "string" ||
    typeof manifest.source.commit !== "string" ||
    typeof manifest.source.license !== "string" ||
    !Array.isArray(manifest.leafPaths) ||
    manifest.leafPaths.some(
      (path) =>
        typeof path !== "string" ||
        path.length === 0 ||
        path.startsWith("[]"),
    )
  ) {
    throw new Error(`Invalid iRacing SessionInfo path manifest ${fileName}`);
  }
  return {
    fileName,
    leafPaths: [...new Set(manifest.leafPaths)].sort(),
  };
}

/** Read raw YAML captures and privacy-safe path manifests from diagnostics. */
export async function readIRacingSessionInfoCaptures(
  directory: string,
): Promise<IRacingSessionInfoCapture[]> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(directory))
      .filter((fileName) => /\.(?:ya?ml|json)$/i.test(fileName))
      .sort();
  } catch (error) {
    throw new Error(
      `Missing iRacing SessionInfo capture directory ${directory}`,
      { cause: error },
    );
  }
  if (fileNames.length === 0) {
    throw new Error(`No iRacing SessionInfo captures found in ${directory}`);
  }

  return Promise.all(
    fileNames.map(async (fileName) => {
      const source = await readFile(resolve(directory, fileName), "utf8");
      let capture: IRacingSessionInfoCapture;
      if (/\.json$/i.test(fileName)) {
        try {
          capture = parseManifest(fileName, JSON.parse(source));
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error(
              `Invalid iRacing SessionInfo path manifest JSON ${fileName}`,
              { cause: error },
            );
          }
          throw error;
        }
      } else {
        capture = {
          fileName,
          leafPaths: collectIRacingSessionInfoLeafPaths(source),
        };
      }
      if (capture.leafPaths.length === 0) {
        throw new Error(
          `iRacing SessionInfo capture ${fileName} contains no leaves`,
        );
      }
      return capture;
    }),
  );
}


export function assertIRacingSessionInfoCaptureCoverage(
  captures: readonly IRacingSessionInfoCapture[],
  catalog: readonly IRacingSessionInfoCatalogEntry[],
): void {
  const exact = new Map(
    catalog
      .filter((field) => !field.path.includes("*"))
      .map((field) => [field.path, field]),
  );
  const missing = new Map<string, Set<string>>();

  for (const capture of captures) {
    for (const leafPath of capture.leafPaths) {
      const field = exact.get(leafPath);
      if (!field) {
        const files = missing.get(leafPath) ?? new Set<string>();
        files.add(capture.fileName);
        missing.set(leafPath, files);
        continue;
      }
      if (!field.unit.trim() || !field.description.trim()) {
        throw new Error(
          `iRacing SessionInfo catalog field ${field.path} requires an explicit unit and description`,
        );
      }
    }
  }

  if (missing.size > 0) {
    throw new Error(
      [
        "Uncatalogued iRacing SessionInfo capture leaves:",
        ...[...missing.entries()]
          .sort(([left], [right]) => compareCatalogStrings(left, right))
          .map(
            ([path, files]) =>
              `- ${path} (${[...files].sort().join(", ")})`,
          ),
      ].join("\n"),
    );
  }
}
