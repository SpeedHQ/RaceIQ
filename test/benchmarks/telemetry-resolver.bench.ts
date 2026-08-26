import { bench, group } from "mitata";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
import type { ResolvedValue } from "../../shared/telemetry/resolver/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { runMitataBenchmarks } from "./mitata-harness";

const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, {
  simulator: "acc",
  requested: [{ semanticId: "motion.speed" }, { semanticId: "inputs.throttle" }, { semanticId: "inputs.brake" }, { semanticId: "fuel.remaining-percent" }],
});
const speed = resolver.slot("motion.speed");
const throttle = resolver.slot("inputs.throttle");
const brake = resolver.slot("inputs.brake");
const fuelRemainingPercent = resolver.slot("fuel.remaining-percent");
const slots = [speed, throttle, brake, fuelRemainingPercent] as const;
const packet = {
  gameId: "acc",
  TimestampMS: 1_000,
  Speed: 71.5,
  Accel: 180,
  Brake: 24,
  Fuel: 45,
  FuelCapacity: 100,
} as TelemetryPacket;
let frame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) });
let sequence = 0;
const diagnosticTarget: ResolvedValue<unknown>[] = [];
let directFrame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) });
let derivedFrame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) });
for (let index = 0; index < 100_000; index += 1) {
  packet.TimestampMS = sequence += 1;
  directFrame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) }, directFrame);
  directFrame.readNumber(speed);
  derivedFrame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) }, derivedFrame);
  derivedFrame.readNumber(fuelRemainingPercent);
}

group("telemetry resolver", () => {
  bench("reusable frame direct readNumber", () => {
    packet.TimestampMS = sequence += 1;
    directFrame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) }, directFrame);
    directFrame.readNumber(speed);
  }).gc("inner");

  bench("reusable frame fuel derivation readNumber", () => {
    packet.TimestampMS = sequence += 1;
    derivedFrame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) }, derivedFrame);
    derivedFrame.readNumber(fuelRemainingPercent);
  }).gc("inner");

  bench("reusable frame and four reads", () => {
    packet.TimestampMS = sequence += 1;
    frame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) }, frame);
    frame.readNumber(speed);
    frame.readNumber(throttle);
    frame.readNumber(brake);
    frame.readNumber(fuelRemainingPercent);
  }).gc("inner");

  bench("diagnostic resolveMany into caller storage", () => {
    packet.TimestampMS = sequence += 1;
    frame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(packet.TimestampMS) }, frame);
    frame.resolveMany(slots, diagnosticTarget);
  }).gc("inner");
});

await runMitataBenchmarks("telemetry-resolver-results.json");
