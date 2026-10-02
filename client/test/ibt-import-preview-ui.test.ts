import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IbtTelemetryWarning } from "../src/components/analyse/IbtTelemetryWarning";

describe("IBT import telemetry warning", () => {
  test("explains why optional channels are unavailable and names them", () => {
    const markup = renderToStaticMarkup(
      createElement(IbtTelemetryWarning, {
        missingVariables: ["LFshockDefl", "RFshockDefl"],
      }),
    );

    expect(markup).toContain("iRacing does not save every live SDK channel in every .ibt file");
    expect(markup).toContain("RaceIQ cannot restore data that was not recorded");
    expect(markup).toContain("Missing channels (2)");
    expect(markup).toContain("LFshockDefl, RFshockDefl");
  });

  test("uses singular copy for one missing channel", () => {
    const markup = renderToStaticMarkup(
      createElement(IbtTelemetryWarning, {
        missingVariables: ["LFshockDefl"],
      }),
    );

    expect(markup).toContain("1 optional RaceIQ telemetry channel");
    expect(markup).toContain("Missing channel (1)");
  });
});
