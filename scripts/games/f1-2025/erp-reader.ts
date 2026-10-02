/**
 * ERP File Reader for EGO Engine archives (F1 25, etc.).
 *
 * Usage: bun run scripts/games/f1-2025/erp-reader.ts <file.erp>
 */
import { parseErpFile } from "./lib/erp";

function compressionName(compression: number): string {
  const names: Record<number, string> = {
    0: "None", 1: "None2", 2: "Zlib", 3: "ZStandard", 4: "ZStandard2",
    5: "ZStandard3", 6: "None3", 7: "None4",
  };
  return names[compression] ?? `Unknown(${compression})`;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: bun run scripts/games/f1-2025/erp-reader.ts <file.erp>");
    process.exit(1);
  }

  const file = Bun.file(filePath);
  const buffer = Buffer.from(await file.arrayBuffer());
  console.log(`File: ${filePath}`);
  console.log(`Size: ${buffer.length} bytes (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log();

  const erp = parseErpFile(buffer);
  console.log("ERP Header:");
  console.log(`  Magic: 0x${erp.header.magic.toString(16)}`);
  console.log(`  Version: ${erp.header.version}`);
  console.log(`  Resource Offset: ${erp.header.resourceOffset}`);
  console.log(`  Num Files: ${erp.header.numFiles}`);
  console.log(`  Num Fragments: ${erp.header.numTempFiles}`);
  console.log(`  Header ended at offset: 0x38`);
  console.log();

  console.log(`=== Resources (${erp.resources.length}) ===`);
  for (const resource of erp.resources) {
    const totalSize = resource.fragments.reduce((sum, fragment) => sum + fragment.size, 0n);
    const totalPacked = resource.fragments.reduce((sum, fragment) => sum + fragment.packedSize, 0n);
    console.log(`  ${resource.identifier}`);
    console.log(`    Type: ${resource.resourceType}  Fragments: ${resource.fragmentCount}  Size: ${totalSize} / Packed: ${totalPacked}`);
    for (const fragment of resource.fragments) {
      console.log(`      [${fragment.name}] offset=${fragment.offset} size=${fragment.size} packed=${fragment.packedSize} compression=${compressionName(fragment.compression)} flags=0x${fragment.flags.toString(16)}`);
    }
  }

  if (process.argv[3] === "--peek") {
    const peekCount = parseInt(process.argv[4] || "5", 10);
    console.log(`\n=== Peeking at first ${peekCount} resources ===`);
    for (let i = 0; i < Math.min(peekCount, erp.resources.length); i++) {
      const resource = erp.resources[i];
      console.log(`\n--- ${resource.identifier} (${resource.resourceType}) ---`);
      for (const fragment of resource.fragments) {
        const offset = Number(erp.header.resourceOffset) + Number(fragment.offset);
        const peekLength = Math.min(64, Number(fragment.packedSize || fragment.size));
        const peek = buffer.subarray(offset, offset + peekLength);
        const hex = Array.from(peek).map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
        const ascii = Array.from(peek).map((byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join("");
        console.log(`  Fragment [${fragment.name}] @ 0x${offset.toString(16)}:`);
        console.log(`    HEX: ${hex}`);
        console.log(`    ASC: ${ascii}`);
      }
    }
  }
}

main().catch(console.error);
