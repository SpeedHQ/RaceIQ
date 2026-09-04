import { appendFileSync, readdirSync, readFileSync } from "node:fs";

const output = process.env.GITHUB_OUTPUT!;
const pr = process.env.PR!;
const baseRef = readFileSync("pr-preview/base-ref.txt", "utf8").trim();
const changed = readdirSync("pr-preview").some((name) => name.endsWith("-after.png"));
appendFileSync(output, `pr=${pr}\nbase-ref=${baseRef}\nchanged=${changed}\n`);
