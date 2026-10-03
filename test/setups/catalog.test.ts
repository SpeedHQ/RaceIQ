import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { carSetupToKnobValues, summarizeCarSetup } from "@raceiq/backend-core/games/ac-evo/carsetup";
import { parseCarSetup } from "@raceiq/backend-core/games/ac-evo/carsetup-wire";
import { patchCarSetup } from "@raceiq/backend-core/games/ac-evo/carsetup-writer";
import { IRACING_SETUP_INFO_FIELDS } from "@raceiq/shared/games/iracing/session-info/catalog";
import { SETUP_CONCEPT_DEFINITIONS } from "@raceiq/shared/racing/setups/catalog/concepts";
import {
  SETUP_FILE_SOURCE_DEFINITIONS,
  SETUP_FILE_SOURCE_TREE,
} from "@raceiq/shared/racing/setups/catalog/file-source-mappings";
import { getSetupCatalogSources } from "@raceiq/shared/racing/setups/catalog/query";
import {
  getSchemaForGame,
  readSetupField,
  readSetupSection,
  writeSetupField,
} from "@raceiq/shared/racing/setups/schema";
import { annotateAcEvoSections, summarizeAcEvoKnobs } from "@raceiq/shared/racing/setups/ac-evo-content";

describe("setup source catalog", () => {
  test("derives typed paths, labels, semantics, and cardinality from one source tree", () => {
    const paths = SETUP_FILE_SOURCE_DEFINITIONS.map((field) => field.path);
    expect(new Set(paths).size).toBe(paths.length);

    for (const field of SETUP_FILE_SOURCE_DEFINITIONS) {
      expect(SETUP_CONCEPT_DEFINITIONS[field.semanticId]).toBeDefined();
      if (field.cardinality.kind === "fixed") {
        expect(field.cardinality.ordering).toHaveLength(field.cardinality.count);
      }
    }

    const pressure = SETUP_FILE_SOURCE_TREE.basicSetup.tyres.fields.tyrePressure;
    expect(pressure.label).toBe("Pressure (clicks)");
    expect(pressure.cardinality.ordering).toEqual(["FL", "FR", "RL", "RR"]);
  });

  test("schema readers and writers use catalogued field handles", () => {
    const accSections = getSchemaForGame("acc");

    const tyreSection = accSections.find((section) => section.key === "basicSetup.tyres")!;
    const pressure = tyreSection.fields.find((field) => field.path === "basicSetup.tyres.tyrePressure")!;
    const setup: Record<string, unknown> = {
      basicSetup: { tyres: { tyrePressure: [49, 50, 49, 49] } },
    };

    expect(readSetupSection(setup, tyreSection)).toEqual({
      tyrePressure: [49, 50, 49, 49],
    });
    expect(readSetupField(setup, pressure)).toEqual([49, 50, 49, 49]);
    writeSetupField(setup, pressure, [50, 50, 50, 50]);
    expect(readSetupField(setup, pressure)).toEqual([50, 50, 50, 50]);
  });

  test("AC Evo imported values populate form fields and edits round-trip through the binary writer", () => {
    const bytes = readFileSync(resolve(import.meta.dir, "../artifacts/carsetup/Default-12312.carsetup"));
    const parsed = parseCarSetup(bytes)!;
    const original = carSetupToKnobValues(parsed);
    const settings: Record<string, unknown> = { ...original };
    const rows = annotateAcEvoSections(summarizeCarSetup(parsed), original).flatMap((section) => section.rows);
    expect(rows.find((row) => row.knob === "frontLeftTyrePressure")?.num).toBeCloseTo(35, 3);
    expect(rows.find((row) => row.knob === "frontSpringRate")?.num).toBe(240);
    const flatRows = summarizeAcEvoKnobs(settings).flatMap((section) => section.rows);
    expect(flatRows.find((row) => row.knob === "rearToe")?.num).toBe(0);
    expect(summarizeAcEvoKnobs({}).flatMap((section) => section.rows).find((row) => row.knob === "rearToe")?.num).toBeUndefined();

    const bias = rows.find((row) => row.knob === "brakeBias")!;
    settings[bias.knob!] = 55 / (bias.scale ?? 1);
    const patched = patchCarSetup(bytes, [{ knob: bias.knob!, value: Number(settings[bias.knob!]) }]);
    const after = carSetupToKnobValues(parseCarSetup(patched)!);
    expect(after.brakeBias).toBeCloseTo(55, 3);
    expect(after.frontLeftTyrePressure).toBeCloseTo(35, 3);
    expect(after.frontSpringRate).toBe(240000);
  });

  test("AC Evo capability annotations keep unavailable imported values read-only", () => {
    const sections = [{
      title: "Front left",
      rows: [{ label: "Camber", value: "-2.5°", num: -2.5 }],
    }];
    const knobs = { frontCamber: -2.5 };
    const unavailable = annotateAcEvoSections(sections, knobs, { frontCamber: null });
    expect(unavailable[0].rows[0]).toMatchObject({ value: "-2.5°", num: -2.5, fixed: true });
    expect(unavailable[0].rows[0].knob).toBeUndefined();

    const unknown = annotateAcEvoSections(sections, knobs, {});
    expect(unknown[0].rows[0]).toMatchObject({ value: "-2.5°", num: -2.5, knob: "frontCamber" });
    const available = annotateAcEvoSections(sections, knobs, { frontCamber: { min: -5, max: 5, step: 0.1 } });
    expect(available[0].rows[0]).toMatchObject({ value: "-2.5°", num: -2.5, knob: "frontCamber" });
  });

  test("exposes known iRacing CarSetup metadata as read-only sources", () => {
    const sources = getSetupCatalogSources("iracing");
    expect(sources).toHaveLength(IRACING_SETUP_INFO_FIELDS.length);
    expect(
      sources.find((source) => source.path === "CarSetup.Chassis.Front.ArbDiameter"),
    ).toMatchObject({
      label: "front ARB diameter",
      semanticId: "setup.suspension.front-anti-roll-bar.diameter",
      sourceKind: "iracing-session-info",
      editable: false,
    });
  });
});
