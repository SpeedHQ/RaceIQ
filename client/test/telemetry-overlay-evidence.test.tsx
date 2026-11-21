import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BodyAttitude } from "../src/components/BodyAttitude";
import { GForceCircle } from "../src/components/telemetry/GForceCircle";
import type { SemanticAnalysisFrame } from "../src/components/analyse/track-map/types";

const frame = (values: Record<string, unknown>, states: Record<string, string> = {}, freshness: Record<string, string> = {}): SemanticAnalysisFrame => ({ values, states, freshness });
const spanValues = (markup: string) => [...markup.matchAll(/<span[^>]*>(.*?)<\/span>/g)].map((match) => match[1].trim());

test("G-force labels show supported acceleration and do not turn invalid channels into zero", () => {
  const markup = renderToStaticMarkup(<GForceCircle frame={frame({ "motion.acceleration-x": 9.81, "motion.acceleration-z": Infinity })} />);
  expect(spanValues(markup)).toEqual(["-1.0", "—"]);
});

test("stale and unavailable acceleration evidence is not displayed as measured G", () => {
  const sample = frame({ "motion.acceleration-x": 9.81, "motion.acceleration-z": 9.81 }, { "motion.acceleration-z": "missing" }, { "motion.acceleration-x": "stale" });
  expect(spanValues(renderToStaticMarkup(<GForceCircle frame={sample} />))).toEqual(["—", "—"]);
});

test("attitude labels keep missing or stale channels unavailable without invalid geometry", () => {
  const sample = frame({ "motion.roll": NaN, "motion.pitch": Infinity, "motion.yaw": 1 }, {}, { "motion.yaw": "stale" });
  const markup = renderToStaticMarkup(<BodyAttitude frame={sample} />);
  const labels = [...markup.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((match) => match[1]);
  expect(labels[0]).toContain("—");
  expect(labels[1]).toContain("—");
  expect(labels.join(" ")).not.toContain("0°");
  expect(markup).not.toMatch(/NaN|Infinity/);
});
