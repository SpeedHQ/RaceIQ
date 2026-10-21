import dgram from "node:dgram";
import { readUdpDump } from "./udp";

/** Replays raw datagrams from a healthy UDP recording into a live listener. */
export class ReplayedUdpDataSource {
  readonly packets: readonly Buffer[];

  constructor(path: string, limit?: number) {
    this.packets = readUdpDump(path, limit);
  }

  async replay(port: number, hostname = "127.0.0.1"): Promise<void> {
    const socket = dgram.createSocket("udp4");
    try {
      for (const packet of this.packets) {
        const sent = Promise.withResolvers<void>();
        socket.send(packet, port, hostname, (error) => {
          if (error) sent.reject(error);
          else sent.resolve();
        });
        await sent.promise;
      }
    } finally {
      socket.close();
    }
  }
}
