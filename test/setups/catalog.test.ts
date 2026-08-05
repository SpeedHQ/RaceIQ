import { describe, expect, test } from "bun:test";
import { IRACING_SETUP_INFO_FIELDS } from "../../shared/games/iracing/session-info/catalog";
import { SETUP_CONCEPT_DEFINITIONS } from "../../shared/racing/setups/catalog/concepts";
import {
  SETUP_FILE_SOURCE_DEFINITIONS,
  SETUP_FILE_SOURCE_TREE,
} from "../../shared/racing/setups/catalog/file-source-mappings";
import { getSetupCatalogSources } from "../../shared/racing/setups/catalog/query";
import {
  getSchemaForGame,
  readSetupField,
  readSetupSection,
  writeSetupField,
} from "../../shared/racing/setups/schema";

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
    const evoSections = getSchemaForGame("ac-evo");
    expect(accSections.some((section) => section.key === "advancedSetup.suspension")).toBe(false);
    expect(evoSections.some((section) => section.key === "advancedSetup.suspension")).toBe(true);

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
