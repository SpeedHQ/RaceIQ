import { describe, expect, test } from "bun:test";
import {
  classifyLapAttribution,
  isWholeLapSelf,
  makeDriverAttributionStint,
  resolveDriverAttribution,
  type DriverAttributionStint,
  type NativeDriverActor,
  type CapturedDriverBinding,
} from "./driver-attribution";

const actor: NativeDriverActor = {
  gameId: "iracing",
  source: "iracing-sdk",
  actorId: "user:42",
  bindingScope: "installation",
  sessionId: "session-1",
  clockDomain: "iracing:session-1",
  observedAtMs: 1000,
};
const selfBinding = {
  gameId: actor.gameId,
  source: actor.source,
  actorId: actor.actorId,
  revision: 3,
};
const observation = {
  actor,
  gameId: actor.gameId,
  source: actor.source,
  sessionId: actor.sessionId,
  clockDomain: actor.clockDomain,
  observedAtMs: 1000,
  maxAgeMs: 500,
};

describe("native driver attribution", () => {
  test("only unique explicit installation-user binding and fresh same-clock evidence identify attribution", () => {
    expect(resolveDriverAttribution({ ...observation, bindings: [selfBinding] }))
      .toEqual({ attribution: "Self", bindingRevision: 3 });
    expect(resolveDriverAttribution({
      ...observation, actor: { ...actor, actorId: "user:99" }, bindings: [selfBinding],
    }).attribution).toBe("Other");
    const sessionBinding = { ...selfBinding, sessionId: actor.sessionId };
    expect(resolveDriverAttribution({
      ...observation, actor: { ...actor, actorId: "user:99" }, bindings: [sessionBinding],
    }).attribution).toBe("Other");
    expect(resolveDriverAttribution({
      ...observation,
      actor: { ...actor, sessionId: "session-2" },
      sessionId: "session-2",
      bindings: [sessionBinding],
    }).attribution).toBe("Unknown");
    expect(resolveDriverAttribution({ ...observation, actor: null, bindings: [selfBinding] }).attribution)
      .toBe("Unknown");
    expect(resolveDriverAttribution({ ...observation, sessionId: "different-session", bindings: [selfBinding] }).attribution)
      .toBe("Unknown");
    expect(resolveDriverAttribution({ ...observation, observedAtMs: 2000, bindings: [selfBinding] }).attribution)
      .toBe("Unknown");
    expect(resolveDriverAttribution({ ...observation, clockDomain: "another-clock", bindings: [selfBinding] }).attribution)
      .toBe("Unknown");
    expect(resolveDriverAttribution({ ...observation, bindings: [selfBinding, selfBinding] }).attribution)
      .toBe("Unknown");
  });
  test("session-scoped native IDs never match an installation-wide binding", () => {
    const sessionActor: NativeDriverActor = {
      ...actor,
      actorId: "session-1:network:7",
      bindingScope: "session",
    };
    const globalBinding = { ...selfBinding, actorId: sessionActor.actorId };
    expect(resolveDriverAttribution({
      ...observation,
      actor: sessionActor,
      bindings: [globalBinding],
    }).attribution).toBe("Unknown");
    expect(resolveDriverAttribution({
      ...observation,
      actor: sessionActor,
      bindings: [{ ...globalBinding, sessionId: sessionActor.sessionId }],
    }).attribution).toBe("Self");
  });

  test("source observations retain provenance when actor evidence is absent", () => {
    expect(makeDriverAttributionStint({
      ...observation,
      actor: null,
      bindings: [selfBinding],
      startMs: 900,
      endMs: 1000,
      evidenceValidUntilMs: 1000,
    })).toMatchObject({
      gameId: "iracing",
      source: "iracing-sdk",
      sessionId: "session-1",
      actor: null,
      attribution: "Unknown",
    });
  });
  test("captured binding snapshots preserve confirmation and reject mismatched source revisions", () => {
    const snapshot: CapturedDriverBinding = {
      id: "confirmed-native-binding", gameId: actor.gameId, sourceKind: actor.source,
      nativeIdentity: JSON.stringify({ schemaVersion: 1, actorId: actor.actorId, bindingScope: "installation" }),
      confirmation: "native_verified", revision: selfBinding.revision,
    };
    const stint = makeDriverAttributionStint({
      ...observation, bindings: [{ ...selfBinding, snapshot }],
      startMs: 1000, endMs: 1100, evidenceValidUntilMs: 1100,
    });
    expect(stint.bindingSnapshot?.confirmation).toBe("native_verified");
    expect(classifyLapAttribution([stint], 1000, 1100, actor.clockDomain)).toBe("Self");
    expect(classifyLapAttribution([{ ...stint, bindingSnapshot: { ...snapshot, revision: 4 } }],
      1000, 1100, actor.clockDomain)).toBe("Unknown");
    expect(resolveDriverAttribution({ ...observation,
      bindings: [{ ...selfBinding, snapshot: { ...snapshot, sourceKind: "different-native-source" } }] }).attribution).toBe("Unknown");
  });

  test("stint swaps, gaps, and unknown intervals prevent personal lap eligibility", () => {
    const stint = (
      startMs: number,
      endMs: number,
      attribution: DriverAttributionStint["attribution"],
    ): DriverAttributionStint => ({
      gameId: actor.gameId,
      source: actor.source,
      sessionId: actor.sessionId,
      startMs,
      endMs,
      attribution,
      evidenceValidUntilMs: endMs,
      clockDomain: actor.clockDomain,
      actor: attribution === "Unknown" ? null : {
        ...actor,
        actorId: attribution,
        observedAtMs: startMs,
      },
      bindingRevision: attribution === "Unknown" ? null : 1,
    });
    expect(classifyLapAttribution([stint(0, 100, "Self")], 10, 90, actor.clockDomain)).toBe("Self");
    expect(classifyLapAttribution([stint(0, 50, "Other"), stint(50, 100, "Other")], 0, 100, actor.clockDomain)).toBe("Other");
    expect(classifyLapAttribution([stint(0, 50, "Self"), stint(50, 100, "Other")], 0, 100, actor.clockDomain)).toBe("Mixed");
    expect(isWholeLapSelf([stint(0, 50, "Self"), stint(50, 100, "Other")], 0, 100, actor.clockDomain)).toBe(false);
    const beforeSwap = stint(0, 50, "Self"), afterSwap = stint(50, 100, "Self");
    expect(classifyLapAttribution([beforeSwap, {
      ...afterSwap, actor: { ...afterSwap.actor!, actorId: "different-native-driver" },
    }], 0, 100, actor.clockDomain)).toBe("Mixed");
    expect(classifyLapAttribution([beforeSwap, {
      ...afterSwap, sessionId: "session-2", actor: { ...afterSwap.actor!, sessionId: "session-2" },
    }], 0, 100, actor.clockDomain)).toBe("Unknown");
    expect(classifyLapAttribution([
      stint(0, 30, "Self"),
      stint(30, 70, "Other"),
      stint(70, 100, "Self"),
    ], 0, 100, actor.clockDomain)).toBe("Mixed");
    expect(classifyLapAttribution([stint(20, 100, "Self")], 0, 100, actor.clockDomain)).toBe("Unknown");
    expect(classifyLapAttribution([stint(0, 40, "Self"), stint(50, 100, "Self")], 0, 100, actor.clockDomain)).toBe("Unknown");
    expect(classifyLapAttribution([stint(0, 100, "Unknown")], 0, 100, actor.clockDomain)).toBe("Unknown");
    expect(classifyLapAttribution([stint(0, 100, "Self")], 0, 100, "wrong-clock")).toBe("Unknown");
    expect(classifyLapAttribution([
      { ...stint(0, 100, "Self"), evidenceValidUntilMs: 50 },
    ], 0, 100, actor.clockDomain)).toBe("Unknown");
    expect(classifyLapAttribution([
      { ...stint(0, 100, "Self"), actor: null },
    ], 0, 100, actor.clockDomain)).toBe("Unknown");
  });
});
