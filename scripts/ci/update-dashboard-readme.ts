import { readFileSync, writeFileSync } from "node:fs";

const path = "assets/screenshots/README.md";
const readme = readFileSync(path, "utf8");
const start = "<!-- dashboard-screenshots-start -->";
const end = "<!-- dashboard-screenshots-end -->";
const block = `\n### F1 2025 Live Dashboard\n\n![F1 2025 Live Dashboard](F1LiveDashboard.png)\n\n### Forza Motorsport Live Dashboard\n\n![Forza Motorsport Live Dashboard](ForzaLiveDashboard.png)\n\n### Assetto Corsa Competizione Live Dashboard\n\n![Assetto Corsa Competizione Live Dashboard](AccLiveDashboard.png)\n`;
const section = `${start}${block}${end}`;
const updated = readme.includes(start) ? readme.replace(new RegExp(`${start}.*?${end}`, "s"), section) : `${readme.trimEnd()}\n\n${section}\n`;
writeFileSync(path, updated);
