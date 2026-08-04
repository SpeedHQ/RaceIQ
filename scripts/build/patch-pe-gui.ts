/**
 * Patch a Windows PE executable from console subsystem (3) to GUI subsystem (2).
 * This prevents a console window from appearing when the exe is launched.
 *
 * Usage: bun scripts/build/patch-pe-gui.ts dist/raceiq.exe
 */
import { readFileSync, writeFileSync } from "fs";

const exePath = process.argv[2];
if (!exePath) {
  console.error("Usage: bun scripts/build/patch-pe-gui.ts <path-to-exe>");
  process.exit(1);
}

const buf = readFileSync(exePath);

// PE header starts at offset stored at 0x3C
const peOffset = buf.readUInt32LE(0x3c);
if (buf.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
  console.error("Not a valid PE file");
  process.exit(1);
}

// Subsystem field is at PE + 0x5C (for PE32+/64-bit)
const subsystemOffset = peOffset + 0x5c;
const current = buf.readUInt16LE(subsystemOffset);

if (current === 2) {
  console.log("Already GUI subsystem, no patch needed");
  process.exit(0);
}

if (current !== 3) {
  console.error(`Unexpected subsystem value: ${current} (expected 3 for console)`);
  process.exit(1);
}

buf.writeUInt16LE(2, subsystemOffset); // IMAGE_SUBSYSTEM_WINDOWS_GUI = 2
writeFileSync(exePath, buf);
console.log(`Patched ${exePath}: console → GUI subsystem`);
