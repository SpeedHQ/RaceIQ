import { expect, test } from "bun:test";
import * as THREE from "three";
import * as wireframeUtils from "../src/lib/wireframe-utils";

type PedalInputColor = (inactive: THREE.Color, active: THREE.Color, inputRatio: number) => THREE.Color;

const pedalInputColor = (wireframeUtils as typeof wireframeUtils & { pedalInputColor?: PedalInputColor }).pedalInputColor;

test("maps full-scale pedal input to the active 3D line color", () => {
  expect(typeof pedalInputColor).toBe("function");

  const inactive = new THREE.Color("#000000");
  const throttle = new THREE.Color("#34d399");
  const color = pedalInputColor!(inactive, throttle, 1);

  expect(color.r).toBeCloseTo(throttle.r);
  expect(color.g).toBeCloseTo(throttle.g);
  expect(color.b).toBeCloseTo(throttle.b);
});
