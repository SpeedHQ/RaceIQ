import { existsSync, readdirSync } from "fs";
import { resolve } from "path";

import { USER_TRACKS_DIR } from "../../runtime/config/paths";
import { scanRecordedFiles } from "../../../shared/track/recording/outlines";
import { findSteamInstall } from "../shared/steam-install";
import { createExtractionState } from "../shared/extraction-state";


export const F1_25_OUT_DIR = resolve(USER_TRACKS_DIR, "f1-2025/extracted");

function findF1Install(): string | null {
  try {
    return findSteamInstall("F1 25");
  } catch {
    return null;
  }
}

export const f1ExtractionState = createExtractionState(!!findF1Install(), 28);

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
    const { extractF1Tracks } = await import("./extract-tracks");
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
