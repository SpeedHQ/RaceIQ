import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.PREVIEW_ROOT;
if (!root) throw new Error("PREVIEW_ROOT is required");

const selected = [
  { suite: "responsive", enabled: process.env.PREVIEW_RESPONSIVE },
  { suite: "storybook", enabled: process.env.PREVIEW_STORYBOOK },
];
if (selected.some(({ enabled }) => enabled !== "true" && enabled !== "false")) {
  throw new Error("Each visual suite requires an explicit selection");
}
const previews = selected.filter(({ enabled }) => enabled === "true").map(({ suite }) => {
  const directory = join(root, `pr-visual-${suite}-preview`);
  if (!["base", "current"].some((side) => existsSync(join(directory, `${side}-${suite}`)))) {
    throw new Error(`Missing selected ${suite} render data`);
  }
  return {
    suite,
    directory,
    pr: readFileSync(join(directory, "pr-number.txt"), "utf8").trim(),
    base: readFileSync(join(directory, "base-ref.txt"), "utf8").trim(),
  };
});
const first = previews[0];
if (first) {
  if (!/^[1-9]\d*$/.test(first.pr) || !/^[\da-f]{40,64}$/.test(first.base) ||
      (process.env.PREVIEW_PR && process.env.PREVIEW_PR !== first.pr) ||
      (process.env.PREVIEW_BASE && process.env.PREVIEW_BASE !== first.base) ||
      previews.some(({ pr, base }) => pr !== first.pr || base !== first.base)) {
    throw new Error("Visual preview artifacts refer to different pull requests or base revisions");
  }
  const output = "pr-preview";
  mkdirSync(output);
  writeFileSync(join(output, "pr-number.txt"), first.pr);
  writeFileSync(join(output, "base-ref.txt"), first.base);
  for (const { suite, directory } of previews) {
    for (const side of ["base", "current"]) {
      const name = `${side}-${suite}`;
      const source = join(directory, name);
      if (existsSync(source)) cpSync(source, join(output, name), { recursive: true });
    }
  }
}
