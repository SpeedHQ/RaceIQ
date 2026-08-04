/**
 * Minimal MoTeC `.ld` writer, for tests.
 *
 * The reader (`server/motec/ld.ts`) was reverse-engineered against a real AC Evo
 * export which is not in the repo — it is a driver's own telemetry, not
 * redistributable fixture data. This builder emits the same layout the reader
 * expects so the transcoder can be tested end-to-end without it: header, a
 * singly-linked list of 124-byte channel-meta blocks, and each channel's sample
 * array as float32.
 *
 * It is deliberately a *writer of the documented layout*, not a mirror of the
 * reader's parsing code — if the two disagree about an offset, the test fails,
 * which is the point.
 */

/** Header field offsets, mirroring server/motec/ld.ts. */
const HEAD = {
  metaPtr: 8,
  dataPtr: 12,
  eventPtr: 36,
  device: 74,
  numChannels: 86,
  date: 94,
  time: 126,
  driver: 158,
  vehicleId: 222,
  venue: 350,
} as const;

const CHAN = {
  nextPtr: 4,
  dataPtr: 8,
  sampleCount: 12,
  dtypeA: 18,
  dtype: 20,
  freq: 22,
  shift: 24,
  mul: 26,
  scale: 28,
  decPlaces: 30,
  name: 32,
  shortName: 64,
  unit: 72,
} as const;

const CHANNEL_BLOCK_SIZE = 124;
/** Where the channel-meta list starts. Comfortably past the header strings. */
const META_PTR = 1024;

export interface LdChannelSpec {
  name: string;
  unit?: string;
  /** Declared sample rate written into the block. */
  freq: number;
  samples: number[] | Float64Array;
}

export interface LdFileSpec {
  driver?: string;
  vehicleId?: string;
  venue?: string;
  date?: string;
  time?: string;
  device?: string;
  eventName?: string;
  eventSession?: string;
  channels: LdChannelSpec[];
}

function writeFixedString(buf: Buffer, offset: number, maxLen: number, value: string): void {
  buf.fill(0, offset, offset + maxLen);
  buf.write(value.slice(0, maxLen - 1), offset, "latin1");
}

/** Build a `.ld` file containing the given channels. */
export function buildLd(spec: LdFileSpec): Buffer {
  const channels = spec.channels;
  const metaSize = channels.length * CHANNEL_BLOCK_SIZE;
  const dataStart = META_PTR + metaSize;

  const dataSize = channels.reduce((sum, c) => sum + c.samples.length * 4, 0);
  const buf = Buffer.alloc(dataStart + dataSize);

  // --- header ---
  buf.writeUInt32LE(META_PTR, HEAD.metaPtr);
  buf.writeUInt32LE(dataStart, HEAD.dataPtr);
  buf.writeUInt32LE(0, HEAD.eventPtr); // no event block; reader tolerates this
  buf.writeUInt16LE(channels.length, HEAD.numChannels);
  writeFixedString(buf, HEAD.device, 8, spec.device ?? "ADL");
  writeFixedString(buf, HEAD.date, 16, spec.date ?? "15/12/2024");
  writeFixedString(buf, HEAD.time, 16, spec.time ?? "09:59:54");
  writeFixedString(buf, HEAD.driver, 64, spec.driver ?? "Test Driver");
  writeFixedString(buf, HEAD.vehicleId, 64, spec.vehicleId ?? "mercedes_amg_gt3_evo");
  writeFixedString(buf, HEAD.venue, 64, spec.venue ?? "spa");

  // --- channel meta blocks + sample arrays ---
  let dataPtr = dataStart;
  channels.forEach((chan, i) => {
    const base = META_PTR + i * CHANNEL_BLOCK_SIZE;
    const isLast = i === channels.length - 1;

    buf.writeUInt32LE(isLast ? 0 : base + CHANNEL_BLOCK_SIZE, base + CHAN.nextPtr);
    buf.writeUInt32LE(dataPtr, base + CHAN.dataPtr);
    buf.writeUInt32LE(chan.samples.length, base + CHAN.sampleCount);
    buf.writeUInt16LE(7, base + CHAN.dtypeA); // float family
    buf.writeUInt16LE(4, base + CHAN.dtype); // 4 bytes wide
    buf.writeUInt16LE(chan.freq, base + CHAN.freq);
    // Identity transform: (raw / 1 * 10^0 + 0) * 1.
    buf.writeInt16LE(0, base + CHAN.shift);
    buf.writeInt16LE(1, base + CHAN.mul);
    buf.writeInt16LE(1, base + CHAN.scale);
    buf.writeInt16LE(0, base + CHAN.decPlaces);
    writeFixedString(buf, base + CHAN.name, 32, chan.name);
    writeFixedString(buf, base + CHAN.shortName, 8, chan.name.slice(0, 7));
    writeFixedString(buf, base + CHAN.unit, 12, chan.unit ?? "");

    for (let s = 0; s < chan.samples.length; s++) {
      buf.writeFloatLE(chan.samples[s]!, dataPtr + s * 4);
    }
    dataPtr += chan.samples.length * 4;
  });

  return buf;
}

/** Build a `.ldx` sidecar with beacon markers at the given times (seconds). */
export function buildLdx(beaconSeconds: number[]): string {
  const markers = beaconSeconds
    .map((t) => `      <Marker Time="${Math.round(t * 1_000_000)}" />`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<LDXFile>
  <Layers>
    <Layer>
      <MarkerGroup Name="Beacons">
${markers}
      </MarkerGroup>
    </Layer>
  </Layers>
</LDXFile>`;
}

/**
 * Generate a synthetic stint: `laps` laps of `lapSeconds` each, driven around a
 * closed loop at a steady yaw rate so the reconstructed path is a circle whose
 * circumference matches the distance covered.
 */
export function syntheticStint(opts: {
  laps: number;
  lapSeconds: number;
  hz: number;
  speedKmh?: number;
}): { spec: LdFileSpec; beacons: number[] } {
  const { laps, lapSeconds, hz } = opts;
  const speedKmh = opts.speedKmh ?? 180;
  const total = Math.round(laps * lapSeconds * hz);

  const speed: number[] = [];
  const throttle: number[] = [];
  const brake: number[] = [];
  const steer: number[] = [];
  const rpm: number[] = [];
  const gear: number[] = [];
  const gLat: number[] = [];
  const gLon: number[] = [];
  const roty: number[] = [];

  // One full rotation per lap → the path closes on itself each lap.
  const yawRate = (2 * Math.PI) / lapSeconds;
  const v = speedKmh / 3.6;

  for (let i = 0; i < total; i++) {
    const tInLap = (i / hz) % lapSeconds;
    // A slow section each lap so the trace has structure to detect corners in.
    const slow = tInLap > lapSeconds * 0.4 && tInLap < lapSeconds * 0.6;
    const s = slow ? speedKmh * 0.6 : speedKmh;
    speed.push(s);
    throttle.push(slow ? 0.3 : 1);
    brake.push(slow ? 0.5 : 0);
    steer.push(slow ? 60 : 5);
    rpm.push(slow ? 5000 : 7000);
    gear.push(slow ? 3 : 5);
    gLat.push((yawRate * v) / 9.80665);
    gLon.push(slow ? -0.8 : 0.2);
    roty.push(yawRate);
  }

  const ch = (name: string, samples: number[], unit?: string): LdChannelSpec => ({
    name,
    freq: hz,
    samples,
    unit,
  });

  return {
    spec: {
      channels: [
        ch("SPEED", speed, "kmh"),
        ch("THROTTLE", throttle),
        ch("BRAKE", brake),
        ch("STEERANGLE", steer, "deg"),
        ch("RPMS", rpm),
        ch("GEAR", gear),
        ch("G_LAT", gLat),
        ch("G_LON", gLon),
        ch("ROTY", roty, "rad/s"),
      ],
    },
    beacons: Array.from({ length: laps - 1 }, (_, i) => (i + 1) * lapSeconds),
  };
}
