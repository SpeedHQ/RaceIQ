/**
 * ERP Resource Extractor - extracts and decompresses resources from ERP archives.
 * Supports ZStandard (compression type 0x11/17) decompression.
 *
 * Usage:
 *   bun run scripts/games/f1-2025/erp-extract.ts <file.erp> <resource-pattern> [--output <dir>]
 *   bun run scripts/games/f1-2025/erp-extract.ts <file.erp> --list-types
 */
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import * as fzstd from "fzstd";
import * as zlib from "zlib";
import { parseErpFile, readErpFragment, type ErpFragment } from "./lib/erp";

async function decompressFragment(buffer: Buffer, resourceOffset: bigint, fragment: ErpFragment): Promise<Buffer> {
  const compressed = readErpFragment(buffer, resourceOffset, fragment);
  if (fragment.compression === 0x91 || fragment.compression === 0 || fragment.compression === 1 || fragment.compression === 6 || fragment.compression === 7) {
    return Buffer.from(compressed);
  }
  if (fragment.compression === 0x11 || fragment.compression === 3 || fragment.compression === 4 || fragment.compression === 5) {
    return Buffer.from(fzstd.decompress(new Uint8Array(compressed)));
  }
  if (fragment.compression === 2) {
    try {
      return Buffer.from(zlib.inflateSync(compressed));
    } catch {
      return Buffer.from(zlib.inflateRawSync(compressed));
    }
  }
  console.log(`    [Unknown compression: ${fragment.compression}, returning raw]`);
  return Buffer.from(compressed);
}

async function main() {
  const args = process.argv.slice(2);
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: bun run scripts/games/f1-2025/erp-extract.ts <file.erp> <pattern> [--output <dir>] [--peek] [--hex]");
    process.exit(1);
  }

  const buffer = Buffer.from(readFileSync(filePath));
  const erp = parseErpFile(buffer);
  const pattern = args[1] || "";
  const outputDir = args.includes("--output") ? args[args.indexOf("--output") + 1] : null;
  const peek = args.includes("--peek");
  const hex = args.includes("--hex");

  if (pattern === "--list-types") {
    const types = new Set(erp.resources.map((resource) => resource.resourceType));
    console.log("Resource types:", [...types].sort().join(", "));
    return;
  }

  const normalizedPattern = pattern.toLowerCase();
  const matching = erp.resources.filter((resource) =>
    resource.identifier.toLowerCase().includes(normalizedPattern) || resource.resourceType.toLowerCase().includes(normalizedPattern),
  );
  console.log(`Found ${matching.length} matching resources (of ${erp.resources.length} total)`);

  for (const resource of matching) {
    console.log(`\n=== ${resource.identifier} ===`);
    console.log(`  Type: ${resource.resourceType}  Fragments: ${resource.fragments.length}`);
    for (let fragmentIndex = 0; fragmentIndex < resource.fragments.length; fragmentIndex++) {
      const fragment = resource.fragments[fragmentIndex];
      console.log(`  Fragment [${fragment.name}]: size=${fragment.size} packed=${fragment.packedSize} compression=0x${fragment.compression.toString(16)}`);
      const data = await decompressFragment(buffer, erp.header.resourceOffset, fragment);
      console.log(`    Decompressed: ${data.length} bytes`);

      if (peek || hex) {
        const showLength = hex ? Math.min(512, data.length) : Math.min(128, data.length);
        for (let offset = 0; offset < showLength; offset += 16) {
          const row = data.subarray(offset, Math.min(offset + 16, showLength));
          const hexString = Array.from(row).map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
          const ascii = Array.from(row).map((byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join("");
          console.log(`    ${offset.toString(16).padStart(8, "0")}  ${hexString.padEnd(48)}  ${ascii}`);
        }
        if (data.length > showLength) console.log(`    ... (${data.length - showLength} more bytes)`);
      }

      if (outputDir) {
        mkdirSync(outputDir, { recursive: true });
        const safeName = resource.identifier.replace(/^eaid:\/\//, "").replace(/[?&=]/g, "_").replace(/\//g, "__");
        const outputFile = join(outputDir, `${safeName}.frag${fragmentIndex}.bin`);
        writeFileSync(outputFile, data);
        console.log(`    Written to: ${outputFile}`);
      }
    }
  }
}

main().catch(console.error);
