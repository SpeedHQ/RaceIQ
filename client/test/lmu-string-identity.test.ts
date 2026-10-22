import { describe, expect, test } from "bun:test";
import { carIdentityKey, trackIdentityKey, type SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { sessionCarName, sessionTrackName } from "@raceiq/sessions-page/ui";
import { validateAnalyseSearch } from "@raceiq/session-analyse/contracts";
import { trackRoutePath } from "../src/lib/track-routes";

const names = { carNames: { "42": "Legacy car", ferrari_499p_2023: "Ferrari 499P 2023" }, trackNames: { "7": "Legacy track", "spa_2023/spawec": "Circuit de Spa-Francorchamps" } };

describe("LMU string identity", () => {
  test("uses one number-or-string identity key", () => {
    expect(trackIdentityKey({ trackOrdinal: -1, trackId: "spa_2023/spawec" })).toBe("spa_2023/spawec");
    expect(carIdentityKey({ carOrdinal: -1, carId: "Custom Vehicle" })).toBe("Custom Vehicle");
    expect(trackIdentityKey({ trackOrdinal: 7, trackId: 7 })).toBe(7);
    expect(carIdentityKey({ carOrdinal: 42, carId: 42 })).toBe(42);
  });

  test("preserves full string keys through routes and Analyse search", () => {
    expect(trackRoutePath("lmu", "spa_2023/spawec")).toBe("/lmu/tracks/spa_2023%2Fspawec");
    expect(validateAnalyseSearch({ track: "spa_2023/spawec", car: "ferrari_499p_2023", lap: "9" })).toMatchObject({
      track: "spa_2023/spawec",
      car: "ferrari_499p_2023",
      lap: 9,
    });
  });

  test("renders catalog names, raw fallback, and unchanged numeric names", () => {
    const lmu = {
      gameId: "lmu",
      id: 1,
      createdAt: "",
      carId: "ferrari_499p_2023",
      trackId: "spa_2023/spawec",
    } as SessionMeta;
    expect(sessionCarName(lmu, names)).toBe("Ferrari 499P 2023");
    expect(sessionTrackName(lmu, names)).toBe("Circuit de Spa-Francorchamps");

    const unresolved = { ...lmu, carId: "Ferrari 499P", trackId: "Circuit de Spa-Francorchamps" };
    expect(sessionCarName(unresolved, names)).toBe("Ferrari 499P");
    expect(sessionTrackName(unresolved, names)).toBe("Circuit de Spa-Francorchamps");

    const numeric: SessionMeta = { id: 2, createdAt: "", gameId: "fm-2023", carId: "42", trackId: "7" };
    expect(sessionCarName(numeric, names)).toBe("Legacy car");
    expect(sessionTrackName(numeric, names)).toBe("Legacy track");
  });
});
