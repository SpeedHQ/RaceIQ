import { describe, expect, test } from "bun:test";

import { acEvoServerAdapter } from "../../server/games/ac-evo";
import { accServerAdapter } from "../../server/games/acc";
import { f1ServerAdapter } from "../../server/games/f1-2025";
import { forzaServerAdapter } from "../../server/games/fm-2023";
import { iracingServerAdapter } from "../../server/games/iracing";
import { packet } from "../support/telemetry/resolver";

const context = { receivedAtMs: 10_010 };

describe("race event source adapters", () => {
  test("keeps unsupported Forza facts unknown", () => {
    const observation = forzaServerAdapter.toRaceEventObservation(
      packet("fm-2023", {
        TimestampMS: 10_000,
        Fuel: 0.5,
        FuelCapacity: undefined,
        TireWearFL: 0.1,
        TireWearFR: 0.2,
        TireWearRL: 0.3,
        TireWearRR: 0.4,
      }),
      context,
    );

    expect(observation.sessionPhase).toBe("unknown");
    expect(observation.participants[0]).toMatchObject({
      participantId: "local-player",
      pitState: "unknown",
      fuelLitres: null,
      damage: null,
      retirementStatus: "unknown",
    });
  });

  test("normalizes Kunos fuel, damage, pit state, and verified flags", () => {
    const acc = accServerAdapter.toRaceEventObservation(
      packet("acc", {
        Fuel: 38.5,
        acc: {
          pitStatus: "in_pit",
          flagStatus: "yellow",
          tireCompound: "dry",
          carDamage: {
            front: 0.2,
            rear: 0.1,
            left: 0,
            right: 0,
            centre: 0.05,
          },
        } as never,
      }),
      context,
    );
    expect(acc.sessionPhase).toBe("caution");
    expect(acc.cautionKind).toBe("local-yellow");
    expect(acc.participants[0]).toMatchObject({
      pitState: "pit-stall",
      fuelLitres: 38.5,
      damage: { front: 20, rear: 10, centre: 5 },
    });

    const acEvo = acEvoServerAdapter.toRaceEventObservation(
      packet("ac-evo", {
        Fuel: 20,
        acc: {
          pitStatus: "out",
          flagStatus: "red",
          tireCompound: "semi-slick",
          carDamage: { front: 0, rear: 0, left: 0, right: 0, centre: 0 },
        } as never,
      }),
      context,
    );
    expect(acEvo.sessionPhase).toBe("red");
    expect(acEvo.participants[0]?.pitState).toBe("out");
  });

  test("maps iRacing local pit and incident facts without world-position claims", () => {
    const observation = iracingServerAdapter.toRaceEventObservation(
      packet("iracing", {
        Fuel: 22,
        iracing: {
          sessionTick: 500,
          onPitRoad: true,
          incidents: 4,
          lapDistanceM: 1_234,
          lapDistancePct: 0.42,
        } as never,
      }),
      context,
    );

    expect(observation.worldPosition).toBeNull();
    expect(observation.trackDistancePct).toBe(0.42);
    expect(observation.sourceSequences).toEqual([
      { family: "iracing-session-tick", sequence: 500 },
    ]);
    expect(observation.participants[0]).toMatchObject({
      participantId: "local-player",
      pitState: "pit-lane",
      incidentCount: 4,
      fuelLitres: 22,
    });
  });

  test("emits F1 session-scoped vehicle identities and preserves native pit code", () => {
    const observation = f1ServerAdapter.toRaceEventObservation(
      packet("f1-2025", {
        Fuel: 0.5,
        FuelCapacity: 100,
        TireWearFL: 0.2,
        TireWearFR: 0.2,
        TireWearRL: 0.25,
        TireWearRR: 0.25,
        f1: {
          packetId: 4,
          overallFrameIdentifier: 80,
          playerCarIndex: 1,
          pitStatus: 2,
          safetyCarStatus: 1,
          frontLeftWingDamage: 15,
          frontRightWingDamage: 0,
          rearWingDamage: 0,
          floorDamage: 0,
          diffuserDamage: 0,
          sidepodDamage: 0,
          penalties: 3,
          grid: [
            {
              carIndex: 0,
              isPlayer: false,
              driverId: 11,
              teamId: 2,
              name: "Opponent",
              position: 1,
              pitStatus: 0,
              tyreCompound: "medium",
            },
            {
              carIndex: 1,
              isPlayer: true,
              driverId: 22,
              teamId: 3,
              name: "Player",
              position: 2,
              pitStatus: 2,
              tyreCompound: "soft",
            },
          ],
        } as never,
      }),
      context,
    );

    expect(observation.rosterAuthoritative).toBe(true);
    expect(observation.sessionPhase).toBe("caution");
    expect(observation.cautionKind).toBe("safety-car");
    expect(observation.participants.map(({ participantId }) => participantId)).toEqual([
      "f1-car:0",
      "f1-car:1",
    ]);
    expect(observation.participants[1]).toMatchObject({
      participantKind: "player",
      driverId: "f1-driver:22",
      teamId: "f1-team:3",
      pitState: "pit-lane",
      nativePitCode: 2,
      fuelLitres: 50,
      damage: { "front-left-wing": 15 },
    });
  });
});
