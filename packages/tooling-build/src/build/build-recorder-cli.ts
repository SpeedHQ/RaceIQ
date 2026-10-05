import { buildRecorder } from "./build-recorder";

await buildRecorder({ release: process.argv.includes("--release") });
