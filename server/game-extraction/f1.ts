import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";

import { USER_TRACKS_DIR } from "../paths";
import { scanRecordedFiles } from "../../shared/track-data";

type ExtractionStatus = "idle" | "running" | "done" | "error";

export interface F1ExtractionState {
  status: ExtractionStatus;
  installed: boolean;
  extracted: number;
  failed: number;
  total: number;
  current: string;
  error: string;
}

export const F1_25_OUT_DIR = resolve(USER_TRACKS_DIR, "f1-2025/extracted");

function findF1Install(): string | null {
  const vdfPath =
    "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf";
  if (!existsSync(vdfPath)) return null;
  try {
    const content = readFileSync(vdfPath, "utf8");
    const pathRegex = /"path"\s+"([^"]+)"/g;
    let match;
    while ((match = pathRegex.exec(content)) !== null) {
      const libPath = match[1].replace(/\\\\/g, "/").replace(/\\/g, "/");
      const f1Path = `${libPath}/steamapps/common/F1 25`;
      if (existsSync(f1Path)) return f1Path;
    }
  } catch {}
  return null;
}

export const f1ExtractionState: F1ExtractionState = {
  status: "idle",
  installed: !!findF1Install(),
  extracted: 0,
  failed: 0,
  total: 28,
  current: "",
  error: "",
};

try {
  if (existsSync(F1_25_OUT_DIR)) {
    const csvs = readdirSync(F1_25_OUT_DIR).filter(
      (f) => f.startsWith("recorded-") && f.endsWith(".csv"),
    );
    if (csvs.length > 0) {
      f1ExtractionState.status = "done";
      f1ExtractionState.extracted = csvs.length;
    }
  }
} catch {}

export async function runF1Extraction(): Promise<void> {
  if (!findF1Install()) {
    f1ExtractionState.status = "error";
    f1ExtractionState.error = "F1 25 not found";
    return;
  }

  f1ExtractionState.status = "running";
  f1ExtractionState.extracted = 0;
  f1ExtractionState.failed = 0;
  f1ExtractionState.error = "";
  f1ExtractionState.current = "Starting...";

  try {
    // Keep game binary tooling out of startup and status-only requests.
    const { extractF1Tracks } = await import("../games/f1-2025/extract-tracks");
    const result = await extractF1Tracks(F1_25_OUT_DIR, (progress) => {
      if (progress.type === "extracted") {
        f1ExtractionState.extracted++;
        f1ExtractionState.current = progress.track;
      } else if (progress.type === "skipped") {
        f1ExtractionState.failed++;
      } else if (progress.type === "total") {
        f1ExtractionState.total = progress.count;
      }
    });

    f1ExtractionState.status = "done";
    f1ExtractionState.current = "";
    f1ExtractionState.extracted = result.extracted;
    scanRecordedFiles();
  } catch (e: any) {
    f1ExtractionState.status = "error";
    f1ExtractionState.error = e.message || "Unknown error";
  }
}
