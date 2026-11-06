import { expect, test } from "bun:test";
import { Line2 } from "three/addons/lines/webgpu/Line2.js";
import { createDrivetrainResource } from "../src/wireframe/Drivetrain";

test("chassis axles join calibrated wheel centers and update when dimensions change", () => {
  const chassis = createDrivetrainResource();
  const segments = () => chassis.root.children.filter((child): child is Line2 => child instanceof Line2).map((line) => {
    const start = line.geometry.getAttribute("instanceStart"), end = line.geometry.getAttribute("instanceEnd");
    return [[start.getX(0), start.getY(0), start.getZ(0)], [end.getX(0), end.getY(0), end.getZ(0)]];
  });
  try {
    chassis.update({ halfWheelbase: 2, halfFrontTrack: 0.75, halfRearTrack: 1 });
    expect(segments()).toEqual(expect.arrayContaining([
      expect.arrayContaining([[2, 0, -0.75], [2, 0, 0.75]]),
      expect.arrayContaining([[-2, 0, -1], [-2, 0, 1]]),
      expect.arrayContaining([[2, 0, 0], [-2, 0, 0]]),
    ]));
    chassis.update({ halfWheelbase: 3, halfFrontTrack: 1, halfRearTrack: 1.25 });
    expect(segments()).toEqual(expect.arrayContaining([
      expect.arrayContaining([[3, 0, -1], [3, 0, 1]]),
      expect.arrayContaining([[-3, 0, -1.25], [-3, 0, 1.25]]),
      expect.arrayContaining([[3, 0, 0], [-3, 0, 0]]),
    ]));
  } finally { chassis.dispose(); }
});
