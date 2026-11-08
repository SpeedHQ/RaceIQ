import { resolve } from "node:path";

const fixturesRoot = resolve(__dirname, "../fixtures");

export function fixturePath(...segments: string[]): string {
  return resolve(fixturesRoot, ...segments);
}
