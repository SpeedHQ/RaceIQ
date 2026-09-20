import { describe, expect, test } from "bun:test";
import {
  createKunosTripletPipeline,
  type Triplet,
  type TripletProcessor,
  type TripletRecorder,
} from "../../../server/games/kunos/triplet-pipeline";

class CapturingRecorder implements TripletRecorder {
  readonly physics: Buffer[] = [];
  readonly graphics: Buffer[] = [];
  readonly staticData: Buffer[] = [];

  writePhysics(buffer: Buffer): void {
    this.physics.push(Buffer.from(buffer));
  }

  writeGraphics(buffer: Buffer): void {
    this.graphics.push(Buffer.from(buffer));
  }

  writeStatic(buffer: Buffer): void {
    this.staticData.push(Buffer.from(buffer));
  }
}

function triplet(tag: number): Triplet {
  return {
    physics: Buffer.from([tag]),
    graphics: Buffer.from([tag + 10]),
    staticData: Buffer.from([tag + 20]),
  };
}

describe("Kunos recording-mode pipeline", () => {
  test("writes every accepted raw triplet without invoking semantic parser", async () => {
    const recorder = new CapturingRecorder();
    let parserCalls = 0;
    const parser: TripletProcessor = {
      async process(): Promise<undefined> {
        parserCalls++;
        throw new Error("semantic parser entered recording mode");
      },
    };
    const pipeline = createKunosTripletPipeline({
      recordingEnabled: true,
      recorder,
      parser,
    });

    await pipeline.process(triplet(1));
    await pipeline.process(triplet(2));

    expect(recorder.physics).toEqual([Buffer.from([1]), Buffer.from([2])]);
    expect(recorder.graphics).toEqual([Buffer.from([11]), Buffer.from([12])]);
    expect(recorder.staticData).toEqual([Buffer.from([21]), Buffer.from([22])]);
    expect(parserCalls).toBe(0);
  });

  test("normal mode invokes semantic parser without writing diagnostic frames", async () => {
    const recorder: TripletRecorder = {
      writePhysics(): void {
        throw new Error("diagnostic recorder entered normal mode");
      },
      writeGraphics(): void {
        throw new Error("diagnostic recorder entered normal mode");
      },
      writeStatic(): void {
        throw new Error("diagnostic recorder entered normal mode");
      },
    };
    const parsed: Triplet[] = [];
    const parser: TripletProcessor = {
      async process(input): Promise<undefined> {
        parsed.push(input);
        return undefined;
      },
    };
    const input = triplet(3);
    const pipeline = createKunosTripletPipeline({
      recordingEnabled: false,
      recorder,
      parser,
    });

    await pipeline.process(input);

    expect(parsed).toEqual([input]);
  });

  test("status gate rejects frames before either mode-specific processor", async () => {
    const recorder = new CapturingRecorder();
    let parserCalls = 0;
    const gate: TripletProcessor = {
      async process(): Promise<boolean> {
        return false;
      },
    };
    const parser: TripletProcessor = {
      async process(): Promise<undefined> {
        parserCalls++;
        return undefined;
      },
    };

    const recordingPipeline = createKunosTripletPipeline({
      recordingEnabled: true,
      recorder,
      parser,
      gate,
    });
    const semanticPipeline = createKunosTripletPipeline({
      recordingEnabled: false,
      recorder,
      parser,
      gate,
    });

    await recordingPipeline.process(triplet(4));
    await semanticPipeline.process(triplet(5));

    expect(recorder.physics).toEqual([]);
    expect(recorder.graphics).toEqual([]);
    expect(recorder.staticData).toEqual([]);
    expect(parserCalls).toBe(0);
  });
});
