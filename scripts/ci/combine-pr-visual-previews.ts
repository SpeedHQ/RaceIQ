import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.PREVIEW_ROOT;
if (!root) throw new Error("PREVIEW_ROOT is required");

const previews = [
  join(root, "pr-visual-responsive-preview"),
  join(root, "pr-visual-storybook-preview"),
];
const output = "pr-preview";
mkdirSync(output, { recursive: true });

const metadata = previews.map((directory) => ({
  pr: readFileSync(join(directory, "pr-number.txt"), "utf8"),
  baseRef: readFileSync(join(directory, "base-ref.txt"), "utf8"),
}));
const responsive = metadata[0]!;
const storybook = metadata[1]!;
if (responsive.pr !== storybook.pr || responsive.baseRef !== storybook.baseRef) {
  throw new Error("Visual preview artifacts refer to different pull requests or base revisions");
}

writeFileSync(join(output, "pr-number.txt"), responsive.pr);
writeFileSync(join(output, "base-ref.txt"), responsive.baseRef);
const names = new Set<string>();
for (const directory of previews) {
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".png"))) {
    if (names.has(name)) throw new Error(`Duplicate visual preview image: ${name}`);
    names.add(name);
    copyFileSync(join(directory, name), join(output, name));
  }
}
