/**
 * @deprecated Use `parseDump` directly. Since each game adapter now specifies
 * its own lap detector implementation (ACC → LapDetectorV2, others → LapDetector),
 * `parseDump` routes ACC recordings through v2 automatically via the pipeline.
 *
 * This re-export is kept so existing tests don't need to change. New code should
 * import `parseDump` from `./parse-dump` directly.
 */
export { parseDump as parseDumpV2 } from "./parse-dump";
export type { DumpResult } from "./parse-dump";
