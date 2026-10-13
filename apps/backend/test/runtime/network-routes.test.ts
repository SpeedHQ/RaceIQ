import {normalizeHudHostname, hudUrl} from "@raceiq/shared/platform/network/hud-hostname";
import { describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { getLanIPv4Addresses } from "../../src/routes/system/network-routes";

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, internal, family: "IPv4", netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` });

describe("remote HUD LAN addresses", () => {
  test("rejects the reported APIPA adapter and prefers the physical LAN over VPNs", () => {
    expect(getLanIPv4Addresses({
      "Ethernet 2": [ipv4("169.254.83.107")],
      "vEthernet (WSL)": [ipv4("172.28.32.1")],
      Tailscale: [ipv4("100.100.1.2")],
      "Wi-Fi": [ipv4("10.0.0.203")],
      Loopback: [ipv4("127.0.0.1", true)],
    })).toEqual(["10.0.0.203", "172.28.32.1", "100.100.1.2"]);
  });
  test("retains alternate physical LANs, deduplicates addresses and excludes invalid destinations", () => {
    expect(getLanIPv4Addresses({
      Ethernet: [ipv4("192.168.1.8"), ipv4("192.168.1.8"), ipv4("0.0.0.0"), ipv4("224.0.0.1"), ipv4("999.1.1.1")],
      "Wi-Fi": [ipv4("10.0.0.203")],
    })).toEqual(["192.168.1.8", "10.0.0.203"]);
    expect(getLanIPv4Addresses({ absent: undefined })).toEqual([]);
  });
});


describe("HUD hostname override", () => {
  test("normalizes names and accepts clearing the override", () => {
    expect(normalizeHudHostname(" Race-PC.Example.ts.net ")).toBe("race-pc.example.ts.net");
    expect(normalizeHudHostname("race-pc")).toBe("race-pc");
    expect(normalizeHudHostname(" ")).toBe("");
  });
  test("rejects URLs, ports and malformed hostnames", () => {
    for (const value of ["http://pc.ts.net", "pc.ts.net:3117", "pc.ts.net/path", "pc.ts.net?x=1", "user@pc.ts.net", "-pc.ts.net", "pc-.ts.net", "pc..ts.net", "pc name", "a".repeat(64)+".net", "a.".repeat(127)+"net"]) {
      expect(normalizeHudHostname(value)).toBeNull();
    }
  });
  test("builds matching URLs without requiring a LAN address", () => {
    expect(hudUrl("race-pc.example.ts.net", 3117, "/portable/combo-1")).toBe("http://race-pc.example.ts.net:3117/portable/combo-1");
    expect(hudUrl("10.0.0.203", "3117", "/portable/combo-2")).toBe("http://10.0.0.203:3117/portable/combo-2");
    expect(hudUrl(undefined, 3117)).toBeNull();
  });
});
