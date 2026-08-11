export interface BxmlWaypoint {
  id: number;
  type: string;
  length: number;
}

export interface BxmlGate {
  id: number;
  name: string;
  position: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  waypoints: BxmlWaypoint[];
}

/** Parse null-separated BXML attribute tokens used by F1 spline resources. */
export function parseBxml(data: Buffer): BxmlGate[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0 || (data[i] < 0x20 && data[i] !== 0x09 && data[i] !== 0x0a && data[i] !== 0x0d)) {
      if (i > start) {
        const value = data.subarray(start, i).toString("utf-8");
        if (value.length > 0 && value.charCodeAt(0) >= 0x20) parts.push(value);
      }
      start = i + 1;
    }
  }

  const gates: BxmlGate[] = [];
  let currentGate: Partial<BxmlGate> | null = null;
  let inWaypoints = false;

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part === "gate" && parts[i + 1] === "id") {
      if (currentGate?.position) gates.push(currentGate as BxmlGate);
      currentGate = {
        id: parseInt(parts[i + 2], 10),
        name: "",
        position: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 0 },
        waypoints: [],
      };
      if (parts[i + 3] === "name") {
        currentGate.name = parts[i + 4];
        i += 5;
      } else {
        i += 3;
      }
      inWaypoints = false;
      continue;
    }

    if (part === "position" && currentGate && !inWaypoints && parts[i + 1] === "x") {
      currentGate.position = {
        x: parseFloat(parts[i + 2]),
        y: parseFloat(parts[i + 4]),
        z: parseFloat(parts[i + 6]),
      };
      i += 7;
      continue;
    }

    if (part === "normal" && currentGate && !inWaypoints && parts[i + 1] === "x") {
      currentGate.normal = {
        x: parseFloat(parts[i + 2]),
        y: parseFloat(parts[i + 4]),
        z: parseFloat(parts[i + 6]),
      };
      i += 7;
      continue;
    }

    if (part === "waypoints" && currentGate) {
      inWaypoints = true;
      i++;
      continue;
    }

    if (part === "waypoint" && inWaypoints && currentGate && parts[i + 1] === "id") {
      const waypoint: BxmlWaypoint = {
        id: parseInt(parts[i + 2], 10),
        type: "",
        length: 0,
      };
      let next = i + 3;
      if (parts[next] === "type") {
        waypoint.type = parts[next + 1];
        next += 2;
      }
      if (parts[next] === "length") {
        waypoint.length = parseFloat(parts[next + 1]);
        next += 2;
      }
      currentGate.waypoints!.push(waypoint);
      i = next;
      continue;
    }

    i++;
  }

  if (currentGate?.position) gates.push(currentGate as BxmlGate);
  return gates;
}
