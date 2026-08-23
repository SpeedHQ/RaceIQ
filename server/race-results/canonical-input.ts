import { createHash, type Hash } from "node:crypto";
import type { TelemetryPacket } from "../../shared/telemetry/types";

/**
 * Hashes normalized packets using canonical v1 framing: JSON packet bytes joined
 * by one newline byte, with no trailing delimiter.
 */
export class CanonicalPacketHasher {
  readonly #hash: Hash = createHash("sha256");
  #packetCount = 0;

  update(packet: TelemetryPacket): void {
    if (this.#packetCount > 0) this.#hash.update("\n");
    this.#hash.update(JSON.stringify(packet));
    this.#packetCount++;
  }

  get packetCount(): number {
    return this.#packetCount;
  }

  digest(): string | null {
    return this.#packetCount === 0 ? null : `sha256:${this.#hash.digest("hex")}`;
  }
}

export function canonicalPacketContentHash(
  packets: Iterable<TelemetryPacket>,
): string | null {
  const hasher = new CanonicalPacketHasher();
  for (const packet of packets) hasher.update(packet);
  return hasher.digest();
}
